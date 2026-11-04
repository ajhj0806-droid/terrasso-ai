import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

// O servidor usa a service_role: ignora RLS, então TODA consulta aqui
// precisa filtrar por tenant_id explicitamente.
export const db = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export async function audit(
  tenantId: string,
  actorType: "ai" | "system" | "staff",
  action: string,
  entity: string,
  entityId: string | null,
  details?: unknown,
) {
  const { error } = await db.from("audit_log").insert({
    tenant_id: tenantId,
    actor_type: actorType,
    action,
    entity,
    entity_id: entityId,
    details: details ?? null,
  });
  if (error) console.error("audit_log", error.message);
}
