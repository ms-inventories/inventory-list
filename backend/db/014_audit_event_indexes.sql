CREATE INDEX IF NOT EXISTS audit_events_tenant_cursor_idx
  ON audit_events(tenant_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_events_tenant_actor_cursor_idx
  ON audit_events(tenant_id, actor_user_id, created_at DESC, id DESC)
  WHERE actor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_events_tenant_action_cursor_idx
  ON audit_events(tenant_id, action, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_events_tenant_entity_cursor_idx
  ON audit_events(tenant_id, entity_type, created_at DESC, id DESC);
