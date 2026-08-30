-- CardioLink Admin - Patient Communications V1
-- Programacion del recordatorio de 24h via pg_cron + pg_net.
--
-- REDACTADA, NO EJECUTADA TODAVIA.
--
-- Migracion SEPARADA y OPCIONAL de 20260828120000 a proposito: el esquema
-- principal (tablas, RLS, funcion de candidatos) no depende de esto. Si
-- pg_cron/pg_net no estan disponibles en el proyecto, o si se prefiere
-- disparar el recordatorio de otra forma al principio (un cron externo que
-- pegue a la Edge Function por HTTPS, por ejemplo), esta migracion se puede
-- simplemente no aplicar sin afectar el resto del modulo.
--
-- Seguridad: el secret que autentica la llamada a la Edge Function
-- (PATIENT_REMINDERS_CRON_SECRET) NUNCA se escribe en este archivo ni en
-- ningun otro del repositorio. Se guarda en Supabase Vault, en el mismo
-- proyecto (Staging o Produccion), a mano, ANTES de aplicar esta migracion:
--
--   select vault.create_secret(
--     '<generar un valor random largo, ej. openssl rand -hex 32>',
--     'patient_reminders_cron_secret'
--   );
--   select vault.create_secret(
--     'https://<PROJECT_REF>.supabase.co/functions/v1/patient-reminders-24h',
--     'patient_reminders_function_url'
--   );
--
-- El mismo valor del primer secret debe configurarse tambien como variable
-- de entorno PATIENT_REMINDERS_CRON_SECRET de la Edge Function
-- patient-reminders-24h (Project Settings -> Edge Functions -> Secrets, o
-- `supabase secrets set`). Sin ese secret configurado en la Edge Function,
-- esta llama siempre devuelve 403 (fail-closed): no existe un modo "sin
-- secret" que igual mande recordatorios.
--
-- Por que Vault y no un literal en el cron job: `cron.schedule` guarda el
-- comando SQL tal cual en cron.job, visible para cualquiera con acceso de
-- lectura a esa tabla de sistema. Vault desacopla el secret real del
-- comando programado.

begin;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Si ya existe un job con este nombre (una corrida anterior de esta misma
-- migracion, por ejemplo), se reemplaza en vez de duplicar.
select cron.unschedule(jobid)
  from cron.job
 where jobname = 'cardiolink-patient-reminders-24h';

select cron.schedule(
  'cardiolink-patient-reminders-24h',
  '*/30 * * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'patient_reminders_function_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'patient_reminders_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $cron$
);

commit;

-- Para desprogramarlo mas adelante:
--   select cron.unschedule(jobid) from cron.job where jobname = 'cardiolink-patient-reminders-24h';
