"""Idempotently configure Authentik for inventory account provisioning.

Run this inside the Authentik server container through ``ak shell``. The
provisioning token is intentionally supplied at runtime and is never stored in
this repository::

    INVENTORY_PROVISION_TOKEN=... INVENTORY_TENANT_ID=<tenant UUID> \
        ak shell < scripts/authentik-mvp-setup.py
"""

from datetime import timedelta
from os import environ
from uuid import NAMESPACE_URL, UUID, uuid5

from django.db import transaction
from django.utils.timezone import now

from authentik.brands.models import Brand
from authentik.core.models import (
    Application,
    Group,
    Token,
    TokenIntents,
    User,
    UserTypes,
)
from authentik.flows.models import Flow, FlowStageBinding, Stage
from authentik.providers.oauth2.models import ScopeMapping
from authentik.rbac.models import Role
from authentik.stages.email.models import EmailStage, EmailTemplates


TOKEN_ENV = "INVENTORY_PROVISION_TOKEN"
TENANT_ID_ENV = "INVENTORY_TENANT_ID"
SERVICE_USERNAME = "inventory-provisioner"
ROLE_NAME = "inventory-provisioner"
TOKEN_IDENTIFIER = "inventory-provisioner-api"
RECOVERY_STAGE_NAME = "Inventory account recovery"
RECOVERY_FLOW_SLUG = "inventory-account-recovery"

SCOPE_MAPPING_UUID = uuid5(
    NAMESPACE_URL,
    "https://876en.org/authentik/inventory-user-uuid-scope",
)
RECOVERY_STAGE_UUID = uuid5(
    NAMESPACE_URL,
    "https://876en.org/authentik/inventory-account-recovery-stage",
)
RECOVERY_FLOW_UUID = uuid5(
    NAMESPACE_URL,
    "https://876en.org/authentik/inventory-account-recovery-flow",
)

MODEL_PERMISSIONS = [
    "authentik_core.view_user",
    "authentik_core.add_user",
    "authentik_core.reset_user_password",
    "authentik_core.view_group",
    "authentik_core.add_group",
    "authentik_core.add_user_to_group",
    "authentik_core.remove_user_from_group",
]


def required_token() -> str:
    token = environ.get(TOKEN_ENV, "")
    if len(token) < 43 or token != token.strip() or any(char.isspace() for char in token):
        raise RuntimeError(f"{TOKEN_ENV} must contain at least 32 random bytes")
    return token


def required_tenant_id() -> str:
    tenant_id = environ.get(TENANT_ID_ENV, "").strip().lower()
    try:
        return str(UUID(tenant_id))
    except (ValueError, AttributeError) as exc:
        raise RuntimeError(f"{TENANT_ID_ENV} must contain the inventory tenant UUID") from exc


@transaction.atomic
def configure() -> None:
    token_key = required_token()
    tenant_id = required_tenant_id()

    mapping = (
        ScopeMapping.objects.filter(scope_name="ak_user_uuid").first()
        or ScopeMapping.objects.filter(name="Inventory immutable user UUID").first()
        or ScopeMapping(pm_uuid=SCOPE_MAPPING_UUID)
    )
    mapping.name = "Inventory immutable user UUID"
    mapping.scope_name = "ak_user_uuid"
    mapping.description = "Stable Authentik user UUID for 876 EN Inventory"
    mapping.expression = 'return {"ak_user_uuid": str(request.user.uuid)}'
    mapping.save()

    application = Application.objects.get(name="876 EN Inventory")
    if application.provider is None:
        raise RuntimeError("876 EN Inventory does not have an Authentik provider")
    application.provider.property_mappings.add(mapping)

    email_stage = (
        EmailStage.objects.filter(name=RECOVERY_STAGE_NAME).first()
        or EmailStage(stage_uuid=RECOVERY_STAGE_UUID)
    )
    email_stage.name = RECOVERY_STAGE_NAME
    email_stage.use_global_settings = True
    email_stage.activate_user_on_success = True
    email_stage.token_expiry = "days=7"
    email_stage.subject = "Set your 876 EN Inventory password"
    email_stage.template = EmailTemplates.PASSWORD_RESET
    email_stage.recovery_max_attempts = 5
    email_stage.recovery_cache_timeout = "minutes=15"
    email_stage.save()

    recovery_flow = Flow.objects.filter(slug=RECOVERY_FLOW_SLUG).first()
    if recovery_flow is None:
        recovery_flow = Flow(flow_uuid=RECOVERY_FLOW_UUID, slug=RECOVERY_FLOW_SLUG)
    recovery_flow.name = "Inventory account recovery"
    recovery_flow.title = "Set your inventory password"
    recovery_flow.designation = "recovery"
    recovery_flow.authentication = "none"
    recovery_flow.compatibility_mode = True
    recovery_flow.save()

    password_prompt = Stage.objects.get(name="default-password-change-prompt")
    password_write = Stage.objects.get(name="default-password-change-write")
    FlowStageBinding.objects.filter(target=recovery_flow).delete()
    FlowStageBinding.objects.create(
        target=recovery_flow,
        stage=password_prompt,
        order=10,
        evaluate_on_plan=False,
        re_evaluate_policies=True,
    )
    FlowStageBinding.objects.create(
        target=recovery_flow,
        stage=password_write,
        order=20,
        evaluate_on_plan=False,
        re_evaluate_policies=True,
    )
    Brand.objects.filter(flow_recovery__isnull=True).update(flow_recovery=recovery_flow)

    service_user = User.objects.filter(username=SERVICE_USERNAME).first()
    if service_user is None:
        service_user = User(username=SERVICE_USERNAME)
    service_user.name = "Inventory Provisioner"
    service_user.email = ""
    service_user.path = "users/inventory"
    service_user.type = UserTypes.SERVICE_ACCOUNT
    service_user.is_active = True
    service_user.set_unusable_password()
    service_user.save()
    service_user.groups.clear()

    # This role is owned exclusively by the inventory provisioning service.
    # Recreate it so reruns cannot retain permissions added outside this setup.
    Role.objects.filter(name=ROLE_NAME).delete()
    role = Role.objects.create(name=ROLE_NAME)
    service_user.roles.set([role])
    role.assign_perms(MODEL_PERMISSIONS)
    role.assign_perms("authentik_stages_email.view_emailstage", email_stage)

    base_group, _ = Group.objects.get_or_create(
        name="876en",
        defaults={"is_superuser": False},
    )
    base_group.is_superuser = False
    base_group.save(update_fields=["is_superuser"])
    base_group.parents.clear()
    base_group.roles.clear()

    tenant_group = Group.objects.filter(name="876en-ms").first()
    if tenant_group is not None:
        tenant_group.attributes = {
            **(tenant_group.attributes or {}),
            "inventory_list_managed": True,
            "inventory_tenant_id": tenant_id,
            "inventory_tenant_slug": "ms",
        }
        tenant_group.is_superuser = False
        tenant_group.save(update_fields=["attributes", "is_superuser"])
        tenant_group.parents.clear()
        tenant_group.roles.clear()

    Token.objects.filter(identifier=TOKEN_IDENTIFIER).delete()
    Token.objects.create(
        identifier=TOKEN_IDENTIFIER,
        key=token_key,
        intent=TokenIntents.INTENT_API,
        user=service_user,
        description="876 EN Inventory provisioning API",
        expiring=True,
        expires=now() + timedelta(days=180),
    )


configure()
print("INVENTORY_AUTHENTIK_SETUP_OK")
