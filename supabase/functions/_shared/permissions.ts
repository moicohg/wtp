// Espejo de PERMISSION_CATEGORIES en dashboard/app.js. Si se agrega un
// permiso allá, agregarlo aquí también.
export const ALL_PERMISSION_KEYS = [
  'leads.view',
  'leads.edit',
  'leads.assign',
  'leads.create_contacts',
  'leads.manage_tags',
  'messaging.view_broadcasts',
  'messaging.send_broadcasts',
  'messaging.manage_templates',
  'messaging.manage_automations',
  'agenda.view_priority_queue',
  'agenda.manage',
  'analytics.dashboard',
  'analytics.ai_usage',
  'config.manage_channels',
  'config.migrate_channels',
  'config.ai_settings',
  'config.alerts',
  'config.products',
  'users.manage_users',
  'users.manage_roles',
] as const;

export type PermissionKey = (typeof ALL_PERMISSION_KEYS)[number];
