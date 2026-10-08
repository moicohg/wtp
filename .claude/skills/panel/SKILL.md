---
name: panel
description: Cómo agregar o cambiar vistas, secciones del menú, modales y permisos en el dashboard de wtp (index.html + app.js + style.css, sin framework ni build). Cargar antes de tocar dashboard/.
---

# Desarrollo del panel (dashboard/)

Tres archivos, sin build ni npm: `index.html` (todas las vistas y modales), `app.js` (módulo ES, ~6.900 líneas) y `style.css`. UI, comentarios y textos en español. Sin dependencias: el cliente de Supabase se importa de esm.sh.

## Patrones del código

- **Vistas**: cada una es `<section id="view-xxx" class="view" hidden>`. `setSection(section)` en `app.js` oculta todas y muestra la activa; cada vista tiene una constante `viewXxx` y un bloque `if (isXxx) { topbarTitle.textContent = …; await loadXxx(); }`.
- **Menú lateral**: `<button class="sidenav-item" data-section="xxx" data-perm="a.b">`. Los canales (`vendor:<id>`) se pintan por código.
- **Permisos en HTML**: `data-perm="x.y"` (uno) o `data-perm-any="x.y a.b"` (cualquiera). `applyPermissionGating()` oculta lo que el usuario no puede; los admins pasan todo. En JS: `can('x.y')`.
- **Acciones del topbar por sección**: `<div class="topbar-actions-group" data-section-group="xxx" hidden>` y se alterna en `setSection`.
- **Modales**: `<div id="xxx-overlay" class="overlay" hidden><div class="modal">` (`modal-sm`/`modal-lg` para tamaño) con `.drawer-header`, botón `✕` y formulario. Se abre con `overlay.hidden = false`.
- **Datos**: `supabase.from(...)` con RLS (el aislamiento por empresa lo hace la base, no filtrar a mano por `organization_id`). Escrituras privilegiadas y operaciones de admin van por Edge Function con `fetch(`${FUNCTIONS_URL}/<fn>`, { headers: await authHeaders() })`; ver `callAdminUsers` como modelo.
- **HTML dinámico**: siempre `escapeHtml()` sobre cualquier dato del usuario antes de meterlo en un template string.
- **Estilos**: variables CSS en `:root` de `style.css` (`--bg`, `--surface`, `--border`, `--text`, `--border-focus` verde `#128c7e`…). Reusar clases existentes (`btn btn-primary`, `btn-ghost`, `chip`, `section-title`) antes de crear nuevas. Iconos: SVG de línea (`stroke="currentColor"`), nada de emojis en el menú lateral.

## Sección nueva, paso a paso

1. `index.html`: botón en `#sidenav` (con `data-perm`) y `<section id="view-xxx" class="view" hidden>`.
2. `app.js`: constante `viewXxx`, agregar `isXxx` en `setSection` (incluida la condición de `isPlaceholder`), `viewXxx.hidden = !isXxx`, y el bloque de carga. Revisar `sectionAllowed()` y `defaultSection()`.
3. Si es un módulo que se puede contratar: agregarlo a `PLAN_SECTIONS` (app.js), `ALL_SECTION_KEYS` (`_shared/sections.ts`) y al check de `organizations.enabled_sections` con una migración. Los tres deben quedar iguales. Cargar también `/plan-limites`.
4. Si usa tablas o columnas nuevas, cargar `/esquema` antes de escribir la migración. El panel solo lee columnas con grant.
5. Permiso nuevo: `PERMISSION_CATEGORIES` en `app.js` **y** `ALL_PERMISSION_KEYS` en `permissions.ts` (ver `/esquema`).

## Verificar

```bash
node --input-type=module --check < dashboard/app.js
```

Detecta nombres repetidos (`const` duplicado) que un chequeo normal no ve; correrlo siempre antes de dar por listo un cambio en `app.js`. Para ver el resultado en pantalla usar `/qa`. Si cambió el comportamiento o una sección, actualizar `README.md`.
