# CardioLink — Patient Communications V1

Estado: **auditoría + implementación V1 completas, NADA desplegado todavía**
(sin commit, sin push, sin `supabase functions deploy`, sin `supabase db push`).
Rama: `patient-communications-v1`.

## 1. Objetivo

Reemplazar gradualmente a MediCloud en la comunicación con pacientes:
confirmación/reprogramación/cancelación por email y WhatsApp al
crear/confirmar/cancelar un turno, más un recordatorio automático 24h
antes. Módulo desacoplado de HC, Finanzas, backfill de pacientes, Portal y
autenticación — no los toca.

## 2. Puntos de integración encontrados (auditoría)

- **Alta de turno**: `guardarAtencion()` ([app.js:1602](../app.js)) — único
  punto real de creación (`on('formAtencion','submit',guardarAtencion)`,
  sin wraps). El registro principal queda en `validos[0]`.
- **Confirmar/cancelar turno**: `cambiarEstadoAgenda(id, estado)` — tiene
  **dos capas de wrap** ya existentes (líneas ~3789 y ~10386, patrón
  `.__flag` para no re-envolver). Se agregó una tercera capa (`.__comms460`)
  siguiendo el mismo patrón, sin tocar las anteriores.
- **Reprogramación**: `guardarEdicionModal()` tiene una cadena de wraps
  igual de profunda (v2.9.3) que edita muchos campos no relacionados con
  fecha/hora en la misma función. Auto-detectar "cambió fecha u hora" ahí
  era frágil (arriesgaba enganchar sobre una capa que no fuera la final, o
  disparar el modal por una edición de facturación sin relación). **Decisión
  de alcance**: no se auto-dispara; se cubre con el botón manual "Notificar
  paciente" (ver más abajo), que deja elegir el tipo exacto.
- **Modelo de prestación**: strings sueltos en `data.profesionales[].prestaciones`
  ([app.js:986](../app.js) `allPrestaciones()`), sin catálogo con id propio.
  Las plantillas se relacionan por nombre normalizado, en una tabla
  independiente — no se tocó el catálogo actual.
- **Email/teléfono real del paciente**: la atención guarda su propio
  snapshot (`a.email`, `a.telefono`, capturados al cargar el turno) y
  `cardiolink_pacientes.email`/`.telefono` es la ficha canónica. Se usa el
  snapshot de la atención primero (consistente con lo que se confirmó en
  su momento) y se completa con la ficha canónica si falta.
- **Infra existente de Edge Functions**: sólo `portal-gateway`. Se
  replicó su estilo (CORS/errores/logging sin PII, service_role
  server-side, `logica.js` separada) para las dos funciones nuevas.
- **Turno = `cardiolink_atenciones` (payload jsonb), no una tabla nueva**:
  ya se sincroniza ahí completo (`sincronizarAtencionesSupabase()`), así
  que el recordatorio 24h lee esa tabla directamente. No se creó ninguna
  tabla relacional de turnos.
- **Texto por prestación ya existente**: `textoWsTurno350()`
  ([app.js:6328](../app.js), v3.4) tenía instrucciones hardcodeadas para
  holter/mapa/eco/default. Se reusó ese mismo texto como semilla de las
  plantillas nuevas (ahora editable), sin inventar instrucciones médicas.
  Esa función original **no se tocó**: sigue siendo el "WhatsApp rápido
  del consultorio" que ya existía, independiente de este módulo.

## 3. Archivos

**Nuevos:**
- `supabase/migrations/20260828120000_cardiolink_communications_schema.sql`
  — tablas, RLS, funciones, semillas. Migración principal.
- `supabase/migrations/20260828121000_cardiolink_communications_reminder_cron.sql`
  — programación del cron (pg_cron+pg_net). **Separada y opcional a
  propósito**: si esas extensiones no están disponibles, el resto del
  módulo funciona igual (el recordatorio se podría disparar por otro medio
  externo más adelante, contra el mismo endpoint).
- `supabase/functions/_shared/comunicaciones-logica.js` — lógica pura
  (normalizar teléfono, elegir plantilla, armar mensaje), compartida por
  las dos Edge Functions.
- `supabase/functions/patient-communications/index.ts` — acciones
  `preview` / `send-email` / `log-whatsapp`, invocada por el Admin.
- `supabase/functions/patient-reminders-24h/index.ts` — recordatorio
  server-side, invocada por cron (nunca por el navegador).
- `docs/PATIENT_COMMUNICATIONS_V1.md` — este documento.

**Modificado:**
- `app.js`: hook en `guardarAtencion()` (después de guardar, fuerza
  sincronización inmediata y abre el modal); wrap adicional de
  `cambiarEstadoAgenda()` (confirmado/cancelado); wrap adicional de
  `abrirAgendaModal()` (botón manual "Notificar paciente"); módulo nuevo
  completo "Patient Communications V1 (460)" al final del archivo.

## 4. Migraciones (resumen)

- `cardiolink_prestacion_templates`: instrucciones + 4 plantillas
  (confirmación/recordatorio/reprogramación/cancelación) + asunto, por
  prestación normalizada. Fila `_default` de respaldo. Semillas con el
  texto ya existente de `textoWsTurno350()`.
- `cardiolink_comunicaciones_config`: fila única, `direccion_consultorio`
  opcional (token `{{direccion}}` queda vacío si no está configurada).
- `cardiolink_communications`: historial. **Único escritor: las Edge
  Functions, con `service_role`** — no hay policy de INSERT/UPDATE para
  `authenticated`, sólo SELECT (para consultar el historial). Índice único
  parcial `(atencion_id, tipo) where tipo='reminder'` para que un
  recordatorio nunca se duplique, a nivel de base de datos, no sólo de
  lógica de aplicación.
- `cardiolink_has_communications_access()`: mismo patrón que
  `cardiolink_has_appointment_requests_access()` — owner/admin/secretaria/
  medico activos. Ver limitación de alcance en la sección 7.
- `cardiolink_atenciones_para_recordatorio_24h()` +
  `cardiolink_intentar_datetime_turno()`: candidatos a recordatorio
  (turnos confirmados cuya fecha+hora cae entre ahora+24h y ahora+24h30m),
  con parseo seguro (nunca rompe la consulta completa por una fecha/hora
  mal formada en una sola fila).

Ninguna migración fue ejecutada.

## 5. Edge Functions (resumen)

- **patient-communications**: exige JWT de un usuario real (lo reenvía
  solo `supabaseClient.functions.invoke`), valida
  `cardiolink_has_communications_access()` vía RPC atada a ese JWT, y
  recién ahí usa un cliente `service_role` para leer/escribir. `send-email`
  nunca confía en texto que mande el cliente: siempre recompone el mensaje
  server-side antes de enviarlo o registrarlo.
- **patient-reminders-24h**: exige un secret propio
  (`PATIENT_REMINDERS_CRON_SECRET`) en el header `Authorization`, distinto
  de `service_role` — sin ese secret configurado, rechaza todo (fail-closed).

## 6. Cómo probarlo paso a paso

**Todo esto es en Staging, nunca en Producción**, siguiendo el mismo
patrón ya usado por Finanzas 5 / Solicitudes de turno (ver
[FINANZAS_V5_STAGING.md](FINANZAS_V5_STAGING.md)).

1. Aplicar `20260828120000_cardiolink_communications_schema.sql` en
   Staging (SQL Editor o `supabase db push` apuntando a Staging).
2. Configurar los secrets de la Edge Function `patient-communications`
   (Project Settings → Edge Functions → Secrets, o `supabase secrets set`):
   - `RESEND_API_KEY` — opcional para probar el flujo de WhatsApp/preview
     sin tenerlo; **obligatorio para que un email realmente salga**.
   - `RESEND_FROM_EMAIL` — remitente verificado en Resend.
   - `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY` —
     ya deberían existir como secrets por defecto en cualquier proyecto
     Supabase con Edge Functions.
3. `supabase functions deploy patient-communications` (Staging).
4. Cargar un paciente de prueba en Staging (mismo patrón `TEST-...` que
   [SOLICITUDES_TURNO_STAGING.md](SOLICITUDES_TURNO_STAGING.md)), con
   email y teléfono de prueba propios (nunca datos reales de un paciente).
5. Desde el Admin conectado a Staging, cargar un turno nuevo para ese
   paciente → debería abrirse el modal "¿Notificar al paciente?" con
   preview del mensaje.
6. Probar "WhatsApp" → debe abrir una pestaña `wa.me` con el texto
   prearmado, y debe aparecer una fila en `cardiolink_communications` con
   `canal='whatsapp'`, `status='manual_started'`.
7. Probar "Email" → sin `RESEND_API_KEY` configurado, debe fallar con el
   mensaje "Proveedor de email no configurado..." y registrar una fila
   `status='failed'` con ese `error_message`. Con la clave configurada,
   debe llegar el email y quedar `status='sent'` con `provider_message_id`.
8. Ir a Agenda → estado del turno → "Confirmado" → debe reabrirse el modal
   (tipo confirmación). → "Cancelado" → mismo modal, tipo cancelación.
9. Abrir el turno desde Agenda → botón "Notificar paciente" → debe
   aparecer el selector de tipo (Confirmación/Reprogramación/Cancelación)
   — probar "Reprogramación" y confirmar que el mensaje generado usa la
   plantilla de reprogramación.
10. Recordatorio 24h: crear un turno confirmado con `fecha`+`horaInicio`
    ~24h en el futuro y email válido. Invocar manualmente la función (con
    el secret correcto en el header) o esperar al cron una vez programado.
    Confirmar que aparece una fila `tipo='reminder'` y que invocarla de
    nuevo para el mismo turno no crea una segunda fila (idempotencia).
11. Limpiar los datos de prueba en `cardiolink_communications` y
    `cardiolink_pacientes` al terminar.

## 7. Qué falta configurar externamente para que el email real funcione

- **Cuenta de Resend** (o el proveedor que se decida): API key
  (`RESEND_API_KEY`) y un remitente verificado (`RESEND_FROM_EMAIL`,
  dominio verificado en Resend). Sin esto, el sistema falla de forma
  controlada y registra el error — no hay ningún modo silencioso.
- **Vault + cron** (sólo si se aplica la migración opcional del cron):
  correr a mano en el SQL Editor del proyecto real (nunca en un archivo
  del repo) `select vault.create_secret(...)` para
  `patient_reminders_cron_secret` y `patient_reminders_function_url`, y
  configurar el mismo valor del primer secret como variable de entorno
  `PATIENT_REMINDERS_CRON_SECRET` de la Edge Function
  `patient-reminders-24h`.
- **Deploy de las dos Edge Functions** (`supabase functions deploy
  patient-communications` / `patient-reminders-24h`) — no ocurre solo.
- **Plantillas/instrucciones por prestación**: revisar y completar desde
  Table Editor (`cardiolink_prestacion_templates`) — las semillas son un
  punto de partida con el texto ya existente, no un contenido médico
  definitivo.
- **Dirección/sede** (opcional): completar
  `cardiolink_comunicaciones_config.direccion_consultorio` si se quiere
  que aparezca en los mensajes.

## 8. Permisos

- Owner/admin/secretaría y médico (activos en `cardiolink_user_roles`)
  pueden enviar comunicaciones administrativas y ver el historial.
- **Límite igual de honesto que en Solicitudes de turno**: la
  autorización real hoy es por rol base, no por "este médico gestiona
  este turno puntual" — `cardiolink_atenciones` no tiene identidad
  relacional propia (payload JSON) para poder expresar esa relación a
  nivel de RLS. La restricción por turno queda, como en el resto del
  proyecto, a nivel de UI/frontend.
- Los mensajes nunca incluyen datos clínicos: sólo paciente, fecha, hora,
  profesional, prestación, dirección e instrucciones administrativas
  configurables.

## 9. Fuera de alcance de esta V1 (deferred, explícito)

- Pantalla de administración de plantillas (se edita por Table Editor).
- Pantalla de historial de comunicaciones dentro del panel de paciente
  (la tabla ya es consultable por SQL/Table Editor; falta la UI).
- WhatsApp Business API automática (según lo pedido: se deja para una
  fase posterior, sobre la misma arquitectura — sólo cambiaría
  `log-whatsapp` para además disparar el envío real, sin tocar el resto).
- Auto-detección de reprogramación en `guardarEdicionModal()` (se cubre
  con el botón manual, ver sección 2).
- Tracking real de apertura de email (`status='opened'` está en el
  esquema pero nada lo setea todavía).
