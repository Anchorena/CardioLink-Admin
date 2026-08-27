-- CardioLink Admin - Backfill historico de cardiolink_pacientes
--
-- REDACTADA, NO EJECUTADA TODAVIA. Ver docs/CARDIOLINK_PATIENT_BACKFILL_AUDIT.md
-- para el analisis completo (causa raiz, estructura historica, reporte real
-- de produccion, decisiones de diseno).
--
-- v2 (reemplaza la version anterior de este mismo archivo): una auditoria
-- de produccion mas profunda encontro que la fuente historica real NO son
-- las filas individuales de cardiolink_atenciones, sino un unico array
-- embebido en la fila tecnica de config: cardiolink_atenciones.payload
-- ->'config'->'pacientes', dentro de la fila con id = '__cardiolink_config_v1'
-- (ver app.js CONFIG_ROW_ID). Esa fila guarda el objeto `data` completo del
-- cliente local, incluido `data.pacientes` (847 objetos en produccion). La
-- version anterior de esta migracion, basada en atenciones individuales,
-- solo llegaba a 186 DNI distintos - un subconjunto muy parcial - y NUNCA
-- se ejecuto. Se descarta ese enfoque y se reconstruye desde cero.
--
-- Objetivo: completar cardiolink_pacientes (tabla canonica, ya consultada
-- correctamente por el Portal Publico) con los pacientes que hoy solo
-- existen en el modelo historico (config.pacientes), sin tocar ningun
-- paciente ya existente.
--
-- Garantias de diseno:
--   - Idempotente: se puede correr mas de una vez sin duplicar nada (el
--     INSERT final excluye por dni_normalizado ya existente).
--   - Nunca hace UPDATE sobre cardiolink_pacientes: solo INSERT de DNI
--     ausentes. Ningun paciente existente cambia de id ni de datos.
--   - Preserva el id historico del paciente (config.pacientes[].id) cuando
--     hay exactamente uno por DNI (803 casos esperados); genera un id nuevo
--     pac_<uuid sin guiones> solo cuando el DNI nunca tuvo un id historico
--     (0 casos esperados en el dataset actual, pero el fallback se
--     mantiene por si se reutiliza esta migracion con otro dataset).
--   - Los DNI con mas de un id historico distinto (6 casos reales) NO se
--     insertan: quedan como conflicto_id_multiple en el reporte, para
--     decidir a mano cual id es el correcto.
--   - Cuando el mismo DNI aparece mas de una vez en config.pacientes (fila
--     duplicada de la misma persona), se elige una sola fila por
--     completitud de datos y, en empate, por la mas reciente segun los
--     campos propios del paciente (actualizadoEn/creadoEn) - NO segun
--     updated_at de cardiolink_atenciones, que es el mismo para todos los
--     pacientes porque viven en la misma fila de config.
--   - Fechas de nacimiento invalidas (formato roto o directamente
--     imposibles, ej. "19988-12-09") nunca se castean directo: se
--     descartan a NULL via una funcion auxiliar con manejo de excepcion,
--     nunca abortan el resto del backfill. Se mantiene esta funcion aunque
--     el dataset actual no tenga fechas invalidas (0 casos), por seguridad
--     y reusabilidad.
--   - No agrega la columna observaciones_administrativas (no existe en el
--     esquema real; el dato queda intacto donde ya estaba, dentro de
--     config.pacientes, sin perderse - fuera de alcance de esta etapa).
--
-- Como usarla:
--   1. Correr TODO el archivo tal cual: primero arma y muestra el reporte
--      (candidatos/insertables/conflictos) en tablas temporales de la
--      misma transaccion, despues hace el INSERT real, y al final vuelve a
--      mostrar un resumen. Todo dentro de la misma transaccion: si algo
--      falla, no queda nada a medio aplicar.
--   2. Para un DRY RUN (ver el reporte sin insertar nada): comentar la
--      seccion "5) BACKFILL REAL" mas abajo y terminar con ROLLBACK en vez
--      de COMMIT.
--
-- Clasificacion esperada contra produccion (ver auditoria del 2026-08-25):
--   total_fuente = 847, dni_validos_distintos = 838, ya_existentes = 29,
--   candidatos = 809, insertables_automaticos = 803,
--   conflicto_id_multiple = 6, conflicto_id_colision = 0, fecha_invalida = 0.
--   cardiolink_pacientes deberia pasar de 29 a ~832 filas.
--
-- NO ejecutar contra Produccion sin revisar el reporte primero.

begin;

-- ---------------------------------------------------------------------------
-- 1) Funciones auxiliares de parseo seguro.
-- ---------------------------------------------------------------------------
-- 1a) Fecha de nacimiento. Un cast directo (elem->>'fechaNacimiento')::date
--     NO es seguro: un valor como '19988-12-09' matchea el patron
--     YYYY-MM-DD y Postgres lo castea sin error (el tipo date admite anios
--     hasta 5874897), asi que un regex simple no alcanza para detectarlo
--     como invalido. Esta funcion:
--       a) descarta vacio o que no empiece con YYYY-MM-DD;
--       b) intenta el cast dentro de BEGIN/EXCEPTION (atrapa fechas con
--          forma valida pero calendario imposible, ej. 2023-02-30);
--       c) aplica un rango razonable (1900-01-01 a hoy) para descartar
--          anios absurdos que un cast directo aceptaria sin quejarse.
-- Ambas funciones se eliminan al final de esta misma migracion: no quedan
-- como objetos permanentes, solo hacian falta para este backfill puntual.
create or replace function public.cardiolink_backfill_intentar_fecha(valor text)
returns date
language plpgsql
stable
as $fn$
declare
  candidata date;
begin
  if valor is null or btrim(valor) = '' then
    return null;
  end if;
  if btrim(valor) !~ '^\d{4}-\d{2}-\d{2}' then
    return null;
  end if;
  begin
    candidata := substring(btrim(valor) from 1 for 10)::date;
  exception when others then
    return null;
  end;
  if candidata < date '1900-01-01' or candidata > current_date then
    return null;
  end if;
  return candidata;
end;
$fn$;

comment on function public.cardiolink_backfill_intentar_fecha(text) is
  'Auxiliar temporal del backfill historico de cardiolink_pacientes '
  '(20260824190000). Se elimina al final de esa misma migracion.';

-- 1b) Timestamp de actualizacion/creacion del paciente (texto libre tal
--     como lo guarda el cliente local: actualizadoEn/creadoEn). Se usa
--     UNICAMENTE para desempatar cual fila usar cuando el mismo DNI
--     aparece mas de una vez en config.pacientes - nunca se inserta en
--     cardiolink_pacientes (las columnas creado_en/actualizado_en del
--     INSERT usan now(), igual que el resto de esta migracion). Mismo
--     patron defensivo que la funcion de fecha: nunca deja que un valor
--     con formato roto rompa el ORDER BY ni el resto del backfill.
create or replace function public.cardiolink_backfill_intentar_timestamp(valor text)
returns timestamptz
language plpgsql
stable
as $fn$
declare
  candidata timestamptz;
begin
  if valor is null or btrim(valor) = '' then
    return null;
  end if;
  begin
    candidata := btrim(valor)::timestamptz;
  exception when others then
    return null;
  end;
  if candidata < timestamptz '1900-01-01' or candidata > (now() + interval '1 day') then
    return null;
  end if;
  return candidata;
end;
$fn$;

comment on function public.cardiolink_backfill_intentar_timestamp(text) is
  'Auxiliar temporal del backfill historico de cardiolink_pacientes '
  '(20260824190000). Se elimina al final de esa misma migracion.';

-- ---------------------------------------------------------------------------
-- 2) Fuente: un array embebido en una unica fila tecnica, no filas sueltas.
-- ---------------------------------------------------------------------------
create temporary table cardiolink_backfill_fuente on commit drop as
with config_row as (
  select payload
  from public.cardiolink_atenciones
  where id = '__cardiolink_config_v1'
  limit 1
)
select
  nullif(btrim(elem.value->>'id'), '') as paciente_id_historico,
  nullif(btrim(elem.value->>'nombreCompleto'), '') as nombre,
  regexp_replace(coalesce(elem.value->>'dni', ''), '\D', '', 'g') as dni_norm,
  (regexp_replace(coalesce(elem.value->>'dni', ''), '\D', '', 'g') ~ '^\d{6,9}$') as dni_valido,
  nullif(btrim(elem.value->>'telefono'), '') as telefono,
  nullif(btrim(elem.value->>'email'), '') as email,
  (elem.value->>'fechaNacimiento') as fecha_nac_cruda,
  public.cardiolink_backfill_intentar_fecha(elem.value->>'fechaNacimiento') as fecha_nac,
  nullif(btrim(elem.value->>'sexo'), '') as sexo,
  nullif(btrim(elem.value->>'localidad'), '') as localidad,
  nullif(btrim(elem.value->>'direccion'), '') as direccion,
  nullif(btrim(elem.value->>'provincia'), '') as provincia,
  -- coberturaHabitual es el campo vigente; obraSocial/cobertura son alias
  -- legacy que aparecen en registros mas viejos del mismo array.
  coalesce(
    nullif(btrim(elem.value->>'coberturaHabitual'), ''),
    nullif(btrim(elem.value->>'obraSocial'), ''),
    nullif(btrim(elem.value->>'cobertura'), '')
  ) as cobertura,
  nullif(btrim(elem.value->>'numeroAfiliadoHabitual'), '') as afiliado,
  nullif(btrim(elem.value->>'contactoResponsableNombre'), '') as contacto_nombre,
  nullif(btrim(elem.value->>'contactoResponsableRelacion'), '') as contacto_relacion,
  nullif(btrim(elem.value->>'contactoResponsableTelefono'), '') as contacto_telefono,
  nullif(btrim(elem.value->>'contactoResponsableEmail'), '') as contacto_email,
  coalesce(
    public.cardiolink_backfill_intentar_timestamp(elem.value->>'actualizadoEn'),
    public.cardiolink_backfill_intentar_timestamp(elem.value->>'creadoEn')
  ) as orden_temporal
from config_row, lateral jsonb_array_elements(coalesce(config_row.payload->'config'->'pacientes', '[]'::jsonb)) as elem(value);

-- ---------------------------------------------------------------------------
-- 3) Clasificacion: una fila por DNI valido, con su decision de id y su
--    estado (candidato / ya_existe / conflicto_id_multiple / conflicto_id_colision).
-- ---------------------------------------------------------------------------
create temporary table cardiolink_backfill_reporte on commit drop as
with con_dni as (
  select * from cardiolink_backfill_fuente where dni_valido
),
-- Una fila por DNI: cuenta ids historicos distintos, y si hay exactamente
-- uno, cual es.
ids_por_dni as (
  select
    dni_norm,
    count(distinct paciente_id_historico) filter (where paciente_id_historico is not null) as ids_distintos,
    max(paciente_id_historico) as id_unico_si_aplica
  from con_dni
  group by dni_norm
),
-- Ranking por completitud (mas campos con dato real = mejor) y, en
-- empate, por el timestamp propio del paciente (actualizadoEn/creadoEn),
-- nunca por updated_at de cardiolink_atenciones (esa fecha es la misma
-- fila tecnica para los 847 pacientes, no distingue nada entre ellos).
rankeadas as (
  select
    *,
    row_number() over (
      partition by dni_norm
      order by
        (nombre is not null)::int
          + (telefono is not null)::int
          + (email is not null)::int
          + (fecha_nac is not null)::int
          + (cobertura is not null)::int
          + (afiliado is not null)::int desc,
        orden_temporal desc nulls last
    ) as rn
  from con_dni
),
mejor_fila as (
  select * from rankeadas where rn = 1
)
select
  m.dni_norm,
  m.nombre,
  m.telefono,
  m.email,
  m.fecha_nac,
  m.fecha_nac_cruda,
  m.sexo,
  m.localidad,
  m.direccion,
  m.provincia,
  m.cobertura,
  m.afiliado,
  m.contacto_nombre,
  m.contacto_relacion,
  m.contacto_telefono,
  m.contacto_email,
  i.ids_distintos,
  i.id_unico_si_aplica,
  case
    when exists (
      select 1 from public.cardiolink_pacientes cp where cp.dni_normalizado = m.dni_norm
    ) then 'ya_existe'
    when coalesce(i.ids_distintos, 0) > 1 then 'conflicto_id_multiple'
    -- Red de seguridad: la auditoria de produccion confirmo que ningun id
    -- historico colisiona con un id ya existente en cardiolink_pacientes,
    -- pero si los datos cambiaron entre esa auditoria y esta corrida, no
    -- confiar ciegamente - un id que ya es de OTRO paciente violaria la PK
    -- al insertar. Se marca aparte para revision manual en vez de fallar
    -- toda la transaccion.
    when coalesce(i.ids_distintos, 0) = 1 and exists (
      select 1 from public.cardiolink_pacientes cp where cp.id = i.id_unico_si_aplica
    ) then 'conflicto_id_colision'
    else 'candidato'
  end as estado,
  case
    when coalesce(i.ids_distintos, 0) = 1
      and not exists (select 1 from public.cardiolink_pacientes cp where cp.id = i.id_unico_si_aplica)
      then i.id_unico_si_aplica
    when coalesce(i.ids_distintos, 0) = 0 then 'pac_' || replace(gen_random_uuid()::text, '-', '')
    else null -- conflicto_id_multiple / conflicto_id_colision: sin id asignado, no se inserta
  end as id_a_usar
from mejor_fila m
join ids_por_dni i on i.dni_norm = m.dni_norm;

-- ---------------------------------------------------------------------------
-- 4) REPORTE PREVIO - revisar esto antes de confiar en el INSERT de mas
--    abajo. Categorias exactas pedidas: total_fuente, dni_validos_distintos,
--    ya_existentes, candidatos, insertables_automaticos,
--    conflicto_id_multiple, conflicto_id_colision, fecha_invalida.
-- ---------------------------------------------------------------------------
select
  (select count(*) from cardiolink_backfill_fuente) as total_fuente,
  (select count(distinct dni_norm) from cardiolink_backfill_fuente where dni_valido) as dni_validos_distintos,
  (select count(*) from cardiolink_backfill_reporte where estado = 'ya_existe') as ya_existentes,
  (select count(*) from cardiolink_backfill_reporte where estado in ('candidato', 'conflicto_id_multiple', 'conflicto_id_colision')) as candidatos,
  (select count(*) from cardiolink_backfill_reporte where estado = 'candidato') as insertables_automaticos,
  (select count(*) from cardiolink_backfill_reporte where estado = 'conflicto_id_multiple') as conflicto_id_multiple,
  (select count(*) from cardiolink_backfill_reporte where estado = 'conflicto_id_colision') as conflicto_id_colision,
  (select count(*) from cardiolink_backfill_reporte where fecha_nac_cruda is not null and fecha_nac is null) as fecha_invalida;

-- ---------------------------------------------------------------------------
-- 5) REPORTE PREVIO - detalle completo (para revisar candidatos y
--    conflictos fila por fila antes de decidir).
-- ---------------------------------------------------------------------------
select
  dni_norm,
  nombre,
  telefono,
  email,
  fecha_nac,
  fecha_nac_cruda,
  cobertura,
  afiliado,
  ids_distintos,
  id_a_usar,
  estado
from cardiolink_backfill_reporte
order by
  case estado
    when 'conflicto_id_multiple' then 0
    when 'conflicto_id_colision' then 1
    when 'candidato' then 2
    else 3
  end,
  dni_norm;

-- ---------------------------------------------------------------------------
-- 6) BACKFILL REAL - solo inserta filas clasificadas 'candidato'
--    (insertables_automaticos). Nunca toca una fila ya existente (no hay
--    ningun UPDATE en este archivo). Idempotente: si se vuelve a correr,
--    todos estos DNI ya van a existir y el WHERE NOT EXISTS del paso 3 los
--    clasifica 'ya_existe', asi que esta insercion queda vacia la segunda
--    vez. No incluye observaciones_administrativas: esa columna no existe
--    en cardiolink_pacientes: el dato correspondiente permanece intacto en
--    config.pacientes, no se pierde ni se migra en esta etapa.
-- ---------------------------------------------------------------------------
insert into public.cardiolink_pacientes (
  id,
  nombre_completo,
  dni,
  telefono,
  email,
  fecha_nacimiento,
  sexo,
  localidad,
  direccion,
  provincia,
  cobertura_habitual,
  numero_afiliado_habitual,
  contacto_responsable_nombre,
  contacto_responsable_relacion,
  contacto_responsable_telefono,
  contacto_responsable_email,
  activo,
  creado_en,
  actualizado_en
)
select
  r.id_a_usar,
  r.nombre,
  r.dni_norm,
  r.telefono,
  r.email,
  r.fecha_nac,
  r.sexo,
  r.localidad,
  r.direccion,
  r.provincia,
  r.cobertura,
  r.afiliado,
  r.contacto_nombre,
  r.contacto_relacion,
  r.contacto_telefono,
  r.contacto_email,
  true,
  now(),
  now()
from cardiolink_backfill_reporte r
where r.estado = 'candidato';

-- ---------------------------------------------------------------------------
-- 7) REPORTE FINAL - cuantos quedaron insertados de verdad.
-- ---------------------------------------------------------------------------
select
  (select count(*) from cardiolink_backfill_reporte where estado = 'candidato') as insertados,
  (select count(*) from cardiolink_backfill_reporte where estado = 'ya_existe') as omitidos_ya_existian,
  (select count(*) from cardiolink_backfill_reporte where estado = 'conflicto_id_multiple') as conflictos_id_multiple,
  (select count(*) from cardiolink_backfill_reporte where estado = 'conflicto_id_colision') as conflictos_id_colision,
  (select count(*) from cardiolink_backfill_reporte where fecha_nac_cruda is not null and fecha_nac is null) as fechas_invalidas;

-- ---------------------------------------------------------------------------
-- 8) Limpieza: las funciones auxiliares eran solo para este backfill puntual.
-- ---------------------------------------------------------------------------
drop function public.cardiolink_backfill_intentar_fecha(text);
drop function public.cardiolink_backfill_intentar_timestamp(text);

commit;
-- Para un dry run: reemplazar el "commit;" de arriba por "rollback;" y
-- comentar la seccion 6) antes de correr el archivo.
