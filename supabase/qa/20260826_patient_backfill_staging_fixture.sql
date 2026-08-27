-- QA STAGING ONLY. NUNCA correr en Producción.
-- Prueba supabase/migrations/20260824190000_cardiolink_pacientes_backfill_historico.sql
-- con datos 100% sintéticos (DNI con prefijo 900000..., nombres "Paciente QA Backfill N").
-- Cero PII real. Pensado para pegar en el SQL Editor de Supabase Staging, paso por paso.

-- =============================================================
-- PASO 1 de 4 — FIXTURE (correr primero, sólo en Staging)
-- =============================================================
begin;

-- Staging no tiene cardiolink_atenciones: se crea con el mismo esquema
-- que Producción, sólo si no existe.
create table if not exists public.cardiolink_atenciones (
  id text primary key,
  payload jsonb,
  updated_at timestamptz default now()
);

-- Pre-existentes en cardiolink_pacientes, necesarios para los casos
-- "DNI ya existente" y "colisión de id".
insert into public.cardiolink_pacientes
  (id, nombre_completo, dni, telefono, activo, creado_en, actualizado_en)
values
  ('pac_QA_BACKFILL_EXISTING', 'Paciente QA Backfill Existente', '900000002', '3410000002', true, now(), now()),
  ('pac_QA_BACKFILL_COLLISION_TARGET', 'Paciente QA Backfill Colision Target', '900000099', '3410000099', true, now(), now())
on conflict (id) do nothing;

-- Fila técnica de config sintética con el array de pacientes de prueba.
insert into public.cardiolink_atenciones (id, payload, updated_at)
values (
  '__cardiolink_config_v1',
  jsonb_build_object(
    'config', jsonb_build_object(
      'pacientes', jsonb_build_array(

        -- CASO 1: id único con datos completos (fecha válida, cobertura/
        -- afiliado, contacto responsable). Verifica: preservación de id.
        jsonb_build_object(
          'id','pac_QA_BACKFILL_CASE1','nombreCompleto','Paciente QA Backfill Uno',
          'dni','900000001','telefono','3410000001','email','qa1@example.test',
          'fechaNacimiento','1988-05-12','sexo','F','localidad','QA Localidad','direccion','QA Direccion 123','provincia','QA Provincia',
          'coberturaHabitual','QA Obra Social','numeroAfiliadoHabitual','QA-AF-001',
          'contactoResponsableNombre','QA Contacto Uno','contactoResponsableRelacion','Hijo/a','contactoResponsableTelefono','3410009001','contactoResponsableEmail','qa1.contacto@example.test',
          'actualizadoEn','2026-01-10T12:00:00Z'
        ),

        -- CASO 2: DNI que ya existe en cardiolink_pacientes. Verifica:
        -- no se modifica ni se duplica.
        jsonb_build_object(
          'id','pac_QA_BACKFILL_CASE2_HIST','nombreCompleto','Paciente QA Backfill Dos Historico',
          'dni','900000002','telefono','3410009002',
          'actualizadoEn','2026-01-10T12:00:00Z'
        ),

        -- CASO 3: mismo DNI + mismo id, dos filas (una mínima, una más
        -- completa/reciente). Verifica: dedup a una sola fila.
        jsonb_build_object(
          'id','pac_QA_BACKFILL_CASE3','nombreCompleto','Paciente QA Backfill Tres',
          'dni','900000003',
          'actualizadoEn','2026-01-05T12:00:00Z'
        ),
        jsonb_build_object(
          'id','pac_QA_BACKFILL_CASE3','nombreCompleto','Paciente QA Backfill Tres Completo',
          'dni','900000003','telefono','3410000003','email','qa3@example.test','coberturaHabitual','QA Obra Social 3',
          'actualizadoEn','2026-01-15T12:00:00Z'
        ),

        -- CASO 4: mismo DNI + ids históricos distintos. Verifica:
        -- conflicto_id_multiple, excluido del INSERT.
        jsonb_build_object(
          'id','pac_QA_BACKFILL_CASE4A','nombreCompleto','Paciente QA Backfill Cuatro A',
          'dni','900000004','actualizadoEn','2026-01-05T12:00:00Z'
        ),
        jsonb_build_object(
          'id','pac_QA_BACKFILL_CASE4B','nombreCompleto','Paciente QA Backfill Cuatro B',
          'dni','900000004','actualizadoEn','2026-01-06T12:00:00Z'
        ),

        -- CASO 5: id histórico que coincide con el id de OTRO paciente ya
        -- existente (DNI distinto). Verifica: conflicto_id_colision,
        -- excluido del INSERT.
        jsonb_build_object(
          'id','pac_QA_BACKFILL_COLLISION_TARGET','nombreCompleto','Paciente QA Backfill Cinco',
          'dni','900000005','actualizadoEn','2026-01-05T12:00:00Z'
        ),

        -- CASO 6: fechaNacimiento inválida. Verifica: no rompe el
        -- backfill, queda NULL, el resto de la fila se inserta igual.
        jsonb_build_object(
          'id','pac_QA_BACKFILL_CASE6','nombreCompleto','Paciente QA Backfill Seis',
          'dni','900000006','fechaNacimiento','19988-12-09','actualizadoEn','2026-01-05T12:00:00Z'
        ),

        -- CASO 7: campos incompletos (sólo dni+id). Verifica: se inserta
        -- igual (nombre_completo nullable).
        jsonb_build_object(
          'id','pac_QA_BACKFILL_CASE7','dni','900000007','actualizadoEn','2026-01-05T12:00:00Z'
        )

      )
    )
  ),
  now()
)
on conflict (id) do update set payload = excluded.payload, updated_at = excluded.updated_at;

commit;

-- =============================================================
-- PASO 2 de 4 — Correr la migración real, sin ningún cambio
-- =============================================================
-- Abrir y correr completo, tal cual está en el repo:
--   supabase/migrations/20260824190000_cardiolink_pacientes_backfill_historico.sql
-- Revisar el reporte previo (sección 4 de ese archivo) antes de que el
-- propio archivo llegue a su "commit;" final. Anotar los 8 números del
-- reporte para comparar contra docs/CARDIOLINK_PATIENT_BACKFILL_AUDIT.md
-- sección 6 (los de Producción) — acá van a ser distintos porque la
-- fuente es este fixture, no el config.pacientes real.

-- =============================================================
-- PASO 3 de 4 — Verificación (correr después del PASO 2)
-- =============================================================

-- A) Preservación de id (CASO 1, 3, 6, 7): el id insertado debe ser
--    exactamente el id histórico, nunca uno generado.
select dni_normalizado, id, nombre_completo, fecha_nacimiento, cobertura_habitual, telefono, email
from public.cardiolink_pacientes
where dni_normalizado in ('900000001','900000003','900000006','900000007')
order by dni_normalizado;
-- esperado:
--   900000001 -> id = pac_QA_BACKFILL_CASE1
--   900000003 -> id = pac_QA_BACKFILL_CASE3, con telefono/email/cobertura de la fila "Tres Completo" (no de la mínima)
--   900000006 -> id = pac_QA_BACKFILL_CASE6, fecha_nacimiento IS NULL
--   900000007 -> id = pac_QA_BACKFILL_CASE7, nombre_completo IS NULL

-- B) DNI ya existente no se modifica (CASO 2).
select id, dni, nombre_completo, telefono
from public.cardiolink_pacientes
where dni_normalizado = '900000002';
-- esperado: id = pac_QA_BACKFILL_EXISTING, nombre = 'Paciente QA Backfill Existente'
-- (si en cambio aparece pac_QA_BACKFILL_CASE2_HIST o 'Dos Historico', es un bug real)

-- C) Conflicto múltiple excluido (CASO 4).
select count(*) as deberia_ser_cero
from public.cardiolink_pacientes where dni_normalizado = '900000004';

-- D) Colisión de id excluida (CASO 5): el DNI 900000005 no debe existir,
--    y el id en disputa debe seguir perteneciendo al paciente original.
select count(*) as deberia_ser_cero
from public.cardiolink_pacientes where dni_normalizado = '900000005';
select id, dni from public.cardiolink_pacientes where id = 'pac_QA_BACKFILL_COLLISION_TARGET';
-- esperado: dni = 900000099 (sin cambios, no lo tocó el conflicto)

-- E) Fecha inválida no rompe el backfill: ya cubierto por A) — si el
--    PASO 2 llegó a "commit;" sin abortar y la fila de 900000006 aparece
--    con fecha_nacimiento NULL, esto pasa.

-- F) Conteo total de este lote (para comparar con la segunda corrida).
select count(*) as pacientes_qa_insertados
from public.cardiolink_pacientes
where dni_normalizado in ('900000001','900000002','900000003','900000006','900000007');
-- esperado: 5 (900000004 y 900000005 quedan afuera por diseño)

-- =============================================================
-- IDEMPOTENCIA — correr el PASO 2 una segunda vez tal cual, después
-- volver a correr el bloque F) de arriba.
-- =============================================================
-- esperado: el mismo resultado (5), sin duplicados ni cambios. El
-- reporte previo de la segunda corrida debe mostrar estos DNI como
-- ya_existentes y 0 en insertables_automaticos.

-- =============================================================
-- PASO 4 de 4 — LIMPIEZA (correr al terminar, sólo en Staging)
-- =============================================================
begin;
delete from public.cardiolink_pacientes
where dni_normalizado in ('900000001','900000002','900000003','900000004','900000005','900000006','900000007','900000099')
   or id like 'pac_QA_BACKFILL_%';
delete from public.cardiolink_atenciones where id = '__cardiolink_config_v1';
commit;
-- La tabla cardiolink_atenciones en sí queda creada en Staging (vacía)
-- para reutilizarla en pruebas futuras del mismo flujo, según lo ya
-- documentado en docs/CARDIOLINK_PATIENT_BACKFILL_AUDIT.md sección 13.3.
-- Si preferís borrarla también: drop table public.cardiolink_atenciones;
