-- CardioLink Admin - Paridad de esquema HC entre STAGING y Production
--
-- Contexto: la capa clinica relacional Fase 1 (v4.1.0-hc, ver el bloque
-- "cardiolinkClinica410" en app.js) depende de dos tablas:
--   - cardiolink_hc_evoluciones
--   - cardiolink_hc_resumen
-- Estas tablas YA EXISTEN en Production con datos reales (confirmado por
-- introspeccion directa el 2026-09-13: 105 y 45 filas respectivamente),
-- pero nunca se crearon en STAGING ni se versionaron como migracion en este
-- repo. Esta migracion cierra ese drift, documentando en el repo el
-- esquema exacto que Production ya tiene (columnas, tipos, checks, FK,
-- indices y policy, confirmados por lectura directa de Production).
--
-- NO-OP REAL SOBRE PRODUCTION: cada tabla se crea SOLO si esta ausente
-- (to_regclass('public.<tabla>') is null). Si la tabla ya existe (como en
-- Production), el bloque completo correspondiente a esa tabla se salta por
-- completo - no se ejecuta CREATE, ALTER, COMMENT, GRANT, REVOKE, CREATE
-- POLICY ni CREATE INDEX contra una tabla existente. No se toca ninguna
-- estructura, privilegio ni policy que ya exista.
--
-- Privilegios: dentro del bloque de creacion se otorgan los mismos grants
-- amplios a nivel tabla que la auditoria de Production confirmo para esta
-- capa (anon + authenticated). Esto es paridad, no un endurecimiento ni un
-- relajamiento de seguridad - una revision de esos privilegios clinicos
-- queda como deuda tecnica separada, fuera del alcance de esta migracion.
--
-- Alcance de esta migracion: SOLO estas dos tablas. No toca app.js, no crea
-- ninguna funcion/RPC, no modifica Edge Functions ni patient-reminders-24h,
-- no modifica ninguna tabla existente.

begin;

-- ---------------------------------------------------------------------------
-- cardiolink_hc_evoluciones (crear solo si esta ausente)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.cardiolink_hc_evoluciones') is null then

    execute $ddl$
      create table public.cardiolink_hc_evoluciones (
        id text not null primary key,
        paciente_id text not null
          references public.cardiolink_pacientes (id)
          on update no action on delete restrict,
        atencion_id text null,
        fecha_hora timestamptz not null default now(),
        profesional_id text null,
        profesional_nombre text null,
        motivo text null,
        evolucion text null,
        diagnostico text null,
        conducta text null,
        peso_kg numeric null,
        talla_cm numeric null,
        imc numeric null,
        ta_sistolica integer null,
        ta_diastolica integer null,
        frecuencia_cardiaca integer null,
        sato2 integer null,
        temperatura numeric null,
        creado_en timestamptz not null default now(),
        creado_por text null,
        editado_en timestamptz null,
        editado_por text null,
        origen text null default 'CardioLink',

        constraint chk_hc_peso
          check (peso_kg is null or peso_kg between 1 and 500),
        constraint chk_hc_talla
          check (talla_cm is null or talla_cm between 40 and 250),
        constraint chk_hc_ta_sistolica
          check (ta_sistolica is null or ta_sistolica between 40 and 300),
        constraint chk_hc_ta_diastolica
          check (ta_diastolica is null or ta_diastolica between 20 and 200),
        constraint chk_hc_fc
          check (frecuencia_cardiaca is null or frecuencia_cardiaca between 20 and 300),
        constraint chk_hc_sato2
          check (sato2 is null or sato2 between 50 and 100)
      )
    $ddl$;

    execute $ddl$
      comment on table public.cardiolink_hc_evoluciones is
        'Capa clinica relacional Fase 1 (v4.1.0-hc). Replica el esquema real '
        'de Production (introspeccion 2026-09-13), donde ya existe con '
        'datos. Creada aca porque estaba ausente en este proyecto - ver '
        'to_regclass() al inicio del bloque de esta migracion. paciente_id '
        '-> cardiolink_pacientes(id) ON DELETE RESTRICT: un paciente con '
        'evoluciones no puede borrarse fisicamente mientras existan.'
    $ddl$;

    execute 'create index idx_hc_evoluciones_paciente on public.cardiolink_hc_evoluciones (paciente_id)';
    execute 'create index idx_hc_evoluciones_atencion on public.cardiolink_hc_evoluciones (atencion_id)';
    execute 'create index idx_hc_evoluciones_fecha on public.cardiolink_hc_evoluciones (fecha_hora desc)';
    execute 'create index idx_hc_evoluciones_profesional on public.cardiolink_hc_evoluciones (profesional_id)';

    execute 'alter table public.cardiolink_hc_evoluciones enable row level security';

    -- Paridad de privilegios con Production (ver nota de alcance arriba).
    execute 'grant select, insert, update, delete on table public.cardiolink_hc_evoluciones to anon, authenticated';

    execute $ddl$
      create policy cardiolink_hc_evoluciones_authenticated
        on public.cardiolink_hc_evoluciones
        for all
        to authenticated
        using (true)
        with check (true)
    $ddl$;

  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- cardiolink_hc_resumen (crear solo si esta ausente)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.cardiolink_hc_resumen') is null then

    execute $ddl$
      create table public.cardiolink_hc_resumen (
        paciente_id text not null primary key
          references public.cardiolink_pacientes (id)
          on update no action on delete cascade,
        antecedentes text null,
        alergias text null,
        medicacion_habitual text null,
        alertas text null,
        actualizado_en timestamptz not null default now(),
        actualizado_por text null
      )
    $ddl$;

    execute $ddl$
      comment on table public.cardiolink_hc_resumen is
        'Capa clinica relacional Fase 1 (v4.1.0-hc). Replica el esquema '
        'real de Production (introspeccion 2026-09-13), donde ya existe '
        'con datos. Creada aca porque estaba ausente en este proyecto - '
        'ver to_regclass() al inicio del bloque de esta migracion. '
        'paciente_id es PK y FK -> cardiolink_pacientes(id) ON DELETE '
        'CASCADE.'
    $ddl$;

    execute 'alter table public.cardiolink_hc_resumen enable row level security';

    -- Paridad de privilegios con Production (ver nota de alcance arriba).
    execute 'grant select, insert, update, delete on table public.cardiolink_hc_resumen to anon, authenticated';

    execute $ddl$
      create policy cardiolink_hc_resumen_authenticated
        on public.cardiolink_hc_resumen
        for all
        to authenticated
        using (true)
        with check (true)
    $ddl$;

  end if;
end
$$;

commit;
