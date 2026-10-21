# Documentos V1 · Bloque B · Cierre parcial (Paso 1: historial visible de envíos)

Rama: `feat/documentos-bloque-b-historial-envios` (desde `origin/main` `6938da7`, Bloque A ya mergeado). Estado: commits locales, sin push, sin PR, sin deploy. Production no tocada.

## 1. Qué incluye

- **Historial de envíos por documento** en la lista de documentos del paciente (solo en `cardiolink-documentos-pdf-v1.js`). Solo lectura de `cardiolink_communications` (`tipo = 'document_delivery'`).
  - Consulta 11 columnas: `id, document_id, paciente_id, created_at, canal, status, destinatario, recipient_name, recipient_source, error_message, created_by`. **Nunca** `message` ni `subject`.
  - Ids consultados: el documento y todas sus versiones (cada envío se registra con el id de la versión enviada), solo de filas de ese paciente ya cargadas, solo de documentos enviables. Lotes de 80. Una consulta por carga; las respuestas viejas se descartan.
  - Defensa adicional: se descartan filas con `paciente_id` de otro paciente (la barrera real es la RLS).
  - Estados que no prometen más de lo que el registro prueba: `sent` + email = "Email aceptado por el proveedor"; `manual_started` = "WhatsApp preparado, envío no confirmado"; `failed` = "Envío fallido" (con motivo); `pending` = "En curso"; `opened` = "Abierto por el destinatario". Nunca "entregado".
  - Estado vacío ("Sin envíos registrados") y error visible ("Historial de envíos no disponible") sin romper la ficha.
  - Tras un envío desde el modal se vuelve a leer el historial (no toca el mecanismo de envío).
- Token de caché del módulo: `?v=4-documentos-v1` → `?v=5-historial-envios` (`index.html`).
- Test de regresión de las plantillas de WhatsApp de documentos (`cardiolink-whatsapp-documento-generado.test.cjs`).

## 2. Lo que NO cambia

`app.js`, `sw.js`, SQL, RLS, Edge Functions (`supabase/` idéntico a `origin/main`), Bloque A, envío de email/WhatsApp, permisos. Sin instrumentación temporal ni configuración de STAGING en el diff (verificado por búsqueda: sin referencias a proyectos, claves, `supabase.co`, `localhost` ni marcas `etapa=`).

## 3. Hallazgo operativo: el 500 de `prepare-whatsapp` en STAGING

- Causa: el código **desplegado** en STAGING (versiones 5 y 6 de `patient-document-delivery`) no coincidía con el repo. `armarMensajeWhatsappDocumentoGenerado()` desplegada usaba `nombrePila` sin declarar; `main` ya tenía `nombreCompleto` desde `658353e` (9/10). Lanzaba una excepción JS sin SQLSTATE (log `ver-detalle-omitido`) y respondía 500 genérico sin registrar nada.
- Corrección: redeploy de la versión 7 en STAGING (coincide con `main`). Verificado: HTTP 200 y una fila `manual_started`, sin duplicados.
- Lección: las Edge Functions se despliegan desde `main`; antes de desplegar en Production, comparar el código desplegado con el del repo.

## 4. Verificación hecha

- Contrato estático/ejecución: `cardiolink-sync-medico-guards.test.cjs` 33/33; `cardiolink-whatsapp-documento-generado.test.cjs` 5/5 (el mismo test falla 3 de 5 si se reintroduce `nombrePila`). Sintaxis del módulo PDF válida. Los dos tests nuevos de historial fallan contra `main`.
- QA real en STAGING (copia local con guarda que bloquea Production y escrituras no autorizadas, datos sintéticos): historial con filas reales (email aceptado, WhatsApp preparado ×1 y ×2, vacío, separación entre pacientes, 11 columnas sin `message`/`subject`) y `prepare-whatsapp` HTTP 200 con una fila `manual_started`.

## 5. QA pendiente (documentado, NO aprobado)

1. **Enlace corto de 7 días**: abrir el enlace del mensaje generado y comprobar el 302 al PDF firmado (5 min) y que un enlace vencido/ajeno da el mensaje genérico. No se verificó de punta a punta (no se conservó el token).
2. **Email nuevo**: envío con destinatario de prueba acordado (p. ej. `delivered@resend.dev`) → fila `sent` ("aceptado por el proveedor") y aviso al profesional. Requiere decidir cargar ese email en un paciente sintético.
3. **Envío fallido**: provocar un `failed` real (no existen filas `failed`) y ver el motivo en el historial.
4. **Idempotencia**: dos envíos del mismo documento/canal/destinatario dentro de 60 s no duplican; pasados 60 s, sí registran un envío nuevo. WhatsApp ×2 se probó solo con filas históricas.
5. **Refresco tras enviar**: que el historial se actualice solo al cerrar el modal de envío.
6. **Perfiles**: lectura del historial con owner/admin y con médico (RLS permite leer todas las filas a owner/admin/secretaría/médico).
7. **Production** (autorización aparte): estado de las dos Edge Functions, secrets (`RESEND_API_KEY`, `RESEND_FROM_EMAIL`), `PATIENT_DOCUMENT_DELIVERY_ALLOWED_ORIGINS`, `PATIENT_DOCUMENT_OPEN_BASE_URL` y migraciones `20261008*`. Las cabeceras de ambas funciones dicen "NO DESPLEGADA EN PRODUCTION".

## 6. Límites conocidos

- `created_by` es un uuid sin nombre legible: el historial muestra "vos / otro usuario".
- Los documentos ligados a una evolución no muestran historial en la lista de Historia Clínica (sí en la ficha).
- Recetas, Indicaciones, Apto físico y Mensaje a colega siguen sin envío (esperan plantilla).
- WhatsApp rápido (`wa.me` directo en HC) y los intentos fallidos previos al envío todavía no se registran en `cardiolink_communications` (pasos siguientes del registro universal); `opened` y el webhook de entrega de Resend tampoco existen aún.
