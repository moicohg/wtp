// Módulos opcionales que se pueden habilitar por empresa (organizations.enabled_sections).
// Canales y Configuración son el núcleo y siempre están. Espejo de PLAN_SECTIONS en
// dashboard/app.js y del check de la migración 20260928000000_secciones_por_empresa.sql.

export const ALL_SECTION_KEYS = [
  'dashboard', 'agenda', 'bandeja-global', 'leads', 'productos', 'catalogo-ia', 'automatizacion', 'disponibilidad',
] as const;

// null = todas las secciones.
export const sectionEnabled = (enabled: string[] | null | undefined, key: string) => !enabled || enabled.includes(key);
