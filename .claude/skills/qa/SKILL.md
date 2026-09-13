---
name: qa
description: Prueba el dashboard de wtp en el navegador con Playwright contra la base de producción. Sirve dashboard/, inicia sesión, crea datos con prefijo "QA " y los borra al terminar. Usar cuando haya que verificar visualmente un cambio de UI o reproducir un bug del panel.
argument-hint: [qué probar]
allowed-tools: Bash, Read, Write, Edit, Grep
---

# Probar el panel de wtp

Qué hay que verificar: `$ARGUMENTS`

El panel apunta **siempre a la base de producción** (no hay entorno local de Supabase). Todo dato que se cree durante la prueba debe llevar el prefijo `QA ` y borrarse al final, pase lo que pase.

## 1. Servir el panel

```bash
cd /Users/user/wtp/dashboard && python3 -m http.server 8000
```

Correrlo en segundo plano. El panel queda en `http://localhost:8000`.

## 2. Credenciales

Opciones en orden de preferencia:

1. Variables de entorno `WTP_QA_EMAIL` y `WTP_QA_PASSWORD` si existen en la sesión.
2. Credenciales que el usuario pase en el mensaje.
3. Si no hay ninguna, **pedirlas**. No crear usuarios en Auth solo para probar sin que el usuario lo autorice.

Para probar como vendedor, el login es por teléfono: el formulario tiene modo "Vendedor" con código de país y número. Internamente se convierte a `<dígitos>@vendedor.invalid`.

## 3. Playwright

Playwright ya está instalado con Chromium. Los scripts van en el scratchpad de la sesión, nunca en el repo.

```js
const { chromium } = require('/Users/user/.npm/_npx/705bc6b22212b352/node_modules/playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto('http://localhost:8000');
  // Modo Empresa (admin, por correo)
  await page.fill('#login-form input[name=email]', process.env.WTP_QA_EMAIL);
  await page.fill('#login-form input[name=password]', process.env.WTP_QA_PASSWORD);
  await page.click('#login-submit-btn');
  await page.waitForSelector('.shell:not([hidden])');

  // Modo Vendedor (por teléfono), si aplica:
  // await page.click('[data-login-mode=vendedor]');
  // await page.selectOption('#login-dial', '51');
  // await page.fill('#login-form input[name=phone]', '987654321');

  // ... la prueba ...

  await page.screenshot({ path: 'captura.png', fullPage: true });
  await browser.close();
})();
```

Antes de usar cualquier otro selector, confirmarlo en `dashboard/index.html` con Grep. Los inputs del panel suelen tener `name` y no `id`.

Navegación: los botones del sidebar llevan `data-section="..."` (dashboard, canales-lista, bandeja-global, productos, catalogo-ia, leads, automatizacion, disponibilidad, empresas). Configuración se abre con `#open-account-settings-btn`.

Tomar capturas en cada paso relevante y mirarlas con Read. Los errores de consola y `pageerror` cuentan como fallo aunque la UI se vea bien.

## 4. Datos de prueba

- Todo lo creado lleva nombre `QA <descripción>` (canales, productos, usuarios, roles, campos, automatizaciones).
- Para borrar, ubicar la fila por su `data-id` o por su texto exacto. **Nunca hacer clic en "el primer botón de borrar"**: en una sesión anterior se borró el rol real "Vendedores" por eso.
- Si algo se creó y la UI no permite borrarlo, borrarlo por SQL:

```bash
supabase db query --linked "delete from public.products where name like 'QA %'"
```

## 5. Limpieza y verificación final

Aunque la prueba falle a mitad, ejecutar la limpieza. Luego confirmar que no quedó nada:

```bash
supabase db query --linked "
select 'vendors' t, count(*) from public.vendors where name like 'QA %'
union all select 'agents', count(*) from public.agents where name like 'QA %'
union all select 'roles', count(*) from public.roles where name like 'QA %'
union all select 'products', count(*) from public.products where name like 'QA %'
union all select 'catalog_files', count(*) from public.catalog_files where name like 'QA %'
union all select 'custom_fields', count(*) from public.custom_fields where name like 'QA %'
union all select 'automations', count(*) from public.automations where name like 'QA %'"
```

Si se creó un usuario QA con login, borrarlo desde Configuración › Usuarios (usa `admin-users`, que también elimina la fila de Auth).

Matar el servidor `http.server` al terminar.

## 6. Reporte

Decir qué se probó, qué funcionó y qué no, con las capturas relevantes. Pegar los errores de consola tal cual. Confirmar explícitamente que la limpieza quedó en cero.
