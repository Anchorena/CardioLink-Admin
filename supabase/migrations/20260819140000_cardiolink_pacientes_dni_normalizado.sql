-- CardioLink Admin - Portal Pacientes V1 / Fase 1
-- Preparacion de DNI normalizado en cardiolink_pacientes.
--
-- Migracion atomica de una sola ejecucion, pensada para aplicarse UNA vez
-- sobre el esquema real de produccion ya auditado (22 pacientes, id text,
-- sin DNI duplicados, todos los DNI actuales son solo numeros, RLS ya
-- habilitado, anon sin filas visibles pero con grants directos vigentes).
--
-- Esta etapa NO modifica datos, NO cambia id, NO impone NOT NULL ni
-- longitud sobre el DNI, NO toca RLS ni las policies de authenticated.
-- Solo agrega una columna generada de solo lectura, un indice unico
-- parcial sobre esa columna, y retira privilegios directos innecesarios
-- de anon.

begin;

-- ---------------------------------------------------------------------------
-- DNI normalizado (columna generada, solo lectura)
-- ---------------------------------------------------------------------------
-- dni_normalizado conserva unicamente los digitos de la columna existente
-- `dni`. Al ser GENERATED ALWAYS ... STORED, Postgres la calcula sola en
-- cada INSERT/UPDATE de `dni`: no admite escritura directa y no requiere
-- backfill manual sobre las filas ya existentes.
--
-- nullif(..., '') convierte un DNI ausente o sin ningun digito en NULL en
-- vez de en cadena vacia, para que el indice unico de mas abajo no trate a
-- todos los pacientes sin DNI cargado como si tuvieran el mismo valor.
alter table public.cardiolink_pacientes
  add column dni_normalizado text
  generated always as (
    nullif(regexp_replace(coalesce(dni, ''), '\D', '', 'g'), '')
  ) stored;

comment on column public.cardiolink_pacientes.dni_normalizado is
  'Solo los digitos de dni, generada automaticamente por Postgres. '
  'NULL si dni esta vacio o no contiene digitos. No se puede escribir '
  'directamente: se recalcula sola a partir de dni.';

-- ---------------------------------------------------------------------------
-- Unicidad futura, sin bloquear el estado actual
-- ---------------------------------------------------------------------------
-- Parcial de forma deliberada: excluye NULL y cadena vacia para no afectar
-- pacientes sin DNI cargado (no se exige NOT NULL en esta etapa). La
-- auditoria de produccion ya confirmo 22 pacientes, sin DNI duplicados y
-- todos unicamente numericos, por lo que este indice deberia poder crearse
-- sin conflicto sobre los datos actuales.
create unique index cardiolink_pacientes_dni_normalizado_uq
  on public.cardiolink_pacientes (dni_normalizado)
  where dni_normalizado is not null and dni_normalizado <> '';

comment on index public.cardiolink_pacientes_dni_normalizado_uq is
  'Unicidad de DNI normalizado solo entre pacientes con DNI cargado. '
  'No aplica a filas con dni_normalizado NULL.';

-- ---------------------------------------------------------------------------
-- Privilegios directos de anon
-- ---------------------------------------------------------------------------
-- La auditoria confirmo que RLS ya bloquea filas para anon, pero la tabla
-- todavia conserva grants directos innecesarios sobre anon. Se retiran para
-- que la ausencia de acceso no dependa solo de que RLS siga habilitado.
-- No se modifica ninguna policy ni los privilegios de authenticated.
revoke all privileges on table public.cardiolink_pacientes from anon;

commit;
