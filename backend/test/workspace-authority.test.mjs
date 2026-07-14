import assert from "node:assert/strict";
import test from "node:test";
import { invitationEmailMatches, listUserWorkspaces } from "../src/routes.js";

test("workspace listing honors exact active database roles and suppresses inactive group matches", async () => {
  const calls = [];
  const queryFn = async (text, params) => {
    calls.push({ text, params });
    return {
      rows: [
        {
          id: "tenant-active",
          slug: "active",
          name: "Active",
          status: "active",
          membership_id: "membership-active",
          membership_role: "viewer",
          membership_status: "active"
        },
        {
          id: "tenant-disabled",
          slug: "disabled",
          name: "Disabled",
          status: "active",
          membership_id: "membership-disabled",
          membership_role: "tenant_admin",
          membership_status: "disabled"
        },
        {
          id: "tenant-group-only",
          slug: "group-only",
          name: "Group only",
          status: "active",
          membership_id: null,
          membership_role: null,
          membership_status: null
        }
      ]
    };
  };

  const workspaces = await listUserWorkspaces({
    groups: ["876en-active", "876en-disabled", "876en-group-only", "876en-platoon-admin"]
  }, { id: "user-1" }, { queryFn, allowGroupFallback: true });

  assert.deepEqual(workspaces, [
    {
      id: "tenant-active",
      slug: "active",
      name: "Active",
      status: "active",
      role: "viewer",
      source: "database"
    },
    {
      id: "tenant-group-only",
      slug: "group-only",
      name: "Group only",
      status: "active",
      role: "tenant_admin",
      source: "authentik"
    }
  ]);
  assert.deepEqual(calls[0].params, [
    "user-1",
    ["active", "disabled", "group-only"],
    true
  ]);
});

test("workspace listing disables all group-only fallback while retaining active database memberships", async () => {
  const queryFn = async (_text, params) => {
    assert.deepEqual(params, ["user-1", [], false]);
    return {
      rows: [{
        id: "tenant-active",
        slug: "active",
        name: "Active",
        status: "active",
        membership_id: "membership-active",
        membership_role: "contributor",
        membership_status: "active"
      }]
    };
  };

  const workspaces = await listUserWorkspaces({
    groups: ["876en-active", "876en-group-only"]
  }, { id: "user-1" }, { queryFn, allowGroupFallback: false });

  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].role, "contributor");
  assert.equal(workspaces[0].source, "database");
});

test("platform admins retain the all-workspace override", async () => {
  const workspaces = await listUserWorkspaces(
    { isPlatformAdmin: true, groups: [] },
    { id: "platform-user" },
    {
      allowGroupFallback: false,
      queryFn: async () => ({
        rows: [{ id: "tenant-ms", slug: "ms", name: "MS", status: "active", role: "tenant_admin", source: "platform_admin" }]
      })
    }
  );

  assert.equal(workspaces[0].role, "tenant_admin");
  assert.equal(workspaces[0].source, "platform_admin");
});

test("legacy invitations always require the normalized intended email", () => {
  assert.equal(invitationEmailMatches(" Leader@Example.Test ", "leader@example.test"), true);
  assert.equal(invitationEmailMatches("invitee@example.test", "platform-admin@example.test"), false);
  assert.equal(invitationEmailMatches("", "platform-admin@example.test"), false);
});
