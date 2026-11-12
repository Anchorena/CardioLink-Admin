-- CardioLink · Seguridad clínica V1 / Bloque 4B · ETAPA A (aditiva): RPC de configuración administrativa para Secretaría  (v3, tras segunda revisión técnica)
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita. SOLO STAGING (yslhwdlzdknhskawqrtv) hasta nueva decisión.
-- Rollback: pending_review_config_secretaria_v1_a_rpc_rollback.sql. Pruebas: pending_review_config_secretaria_v1_tests.sql. Checks: …_checks.sql.
-- SIN EJECUTAR: no se pudo validar la sintaxis contra una base (no hay Postgres local); revisar con el SQL Editor de STAGING antes de confiar.
--
-- PROBLEMA. La fila `__cardiolink_config_v1` de cardiolink_atenciones guarda el objeto `data` completo de la app (evoluciones, resúmenes,
-- documentos, notas internas, finanzas…) y la política cardiolink_atencion_permitida_v2 deja leerla y escribirla a Secretaría.
--
-- QUÉ AGREGA ESTA ETAPA (no cambia ninguna política ni dato; el comportamiento actual no cambia hasta la ETAPA B):
--   1) cardiolink_config_administrativa_v1()  → devuelve SÓLO lo permitido a Secretaría (más `updated_at` y un hash de la parte escribible).
--   2) cardiolink_guardar_config_administrativa_v1(config, base_updated_at, base_hash, uid_esperado) → aplica SÓLO lo permitido, FUSIONÁNDOLO con la fila existente.
--      uid_esperado (cambio de sesión): OBLIGATORIO y sin DEFAULT. El cliente manda el id del usuario que INICIÓ el guardado. NULL → 22023 (HINT 'UID_ESPERADO_OBLIGATORIO');
--      omitido → 42883 (la firma de 3 argumentos no existe); distinto de auth.uid() (cierre de sesión, otro usuario en otra pestaña) → 42501 (HINT 'SESION_DISTINTA').
--      En los tres casos no se escribe nada.
--      Todo lo demás se conserva idéntico, byte a byte. Control de concurrencia con updated_at (+ hash). Sin fallback: si falla, falla (el cliente lo muestra).
--   Ambas son SECURITY DEFINER, sólo ejecutables por `authenticated`, y exigen rol backend ACTIVO = 'secretaria' (owner/admin/médico: 42501).
--
-- LISTAS EXPLÍCITAS (fail-closed). Hay dos niveles: claves superiores Y campos anidados.
--   CLAVES SUPERIORES
--     LECTURA : catálogos, convenios/aranceles, profesionales, pacientes, usuarios, roles, etc. + documentosClinicos FILTRADO (ver abajo).
--     ESCRITURA = LECTURA menos {usuarios, roles, brandingCardioLink, migracionesCardioLink, documentosClinicos}.
--     NUNCA: evolucionesClinicas, resumenesClinicos, importacionesMedicloudEvoluciones, notasInternasMedicas, notasInternasPorProfesional,
--            configFinanzas411F, movimientosFinancieros411C, hcPreparacion, integracionesClinicas, identidadesArchivadas y toda clave desconocida.
--   CAMPOS ANIDADOS
--     pacientes[]      : 27 campos administrativos (CAMPOS_PACIENTE). Lectura y escritura. Cualquier otro campo del paciente NO se lee ni se escribe;
--                        en un paciente existente se conserva tal cual (la fusión parte del elemento existente).
--     profesionales[]  : escritura SÓLO de CAMPOS_PROFESIONAL_ADMIN (id, nombre, area, prestaciones, valores, especialidadIds, bloquesPrestaciones, activo).
--                        Lectura: esos + las 12 claves de IDENTIDAD documental (Secretaría las necesita para imprimir documentos que emite, pero NUNCA se escriben).
--                        Firmas, logos, matrículas y demás identidad: imposibles de alterar por esta RPC (se parte del elemento existente y sólo se pisan los campos admin).
--     documentosClinicos[]: LECTURA de los documentos cuyo `tipo` está en TIPOS_DOC_SECRETARIA (hoy sólo 'constancia_atencion'); NUNCA escritura.
--                        Los documentos nuevos se archivan en cardiolink_patient_documents (Documentos V1) y el cliente los sincroniza desde ahí. Los documentos heredados
--                        (13 en STAGING; sólo 2 con source_document_id confirmado) quedan INTACTOS en la fila: esta RPC no los modifica nunca.
--   (tests/config-secretaria-v1.js verifica que las listas del cliente y las de este archivo coincidan y que toda clave `data.<x>` del código esté clasificada.)
--
-- REGLAS DE FUSIÓN (escritura):
--   * Clave ausente → se deja como está. Valor null o de distinto tipo JSON que el existente → se RECHAZA (22023).
--   * pacientes / profesionales / obrasSociales: arreglo vacío sobre uno no vacío → se RECHAZA (anti-vaciado accidental).
--   * pacientes: por id; elementos sin id, no-objeto o con id duplicado → 22023. Quitar un paciente que tiene historia clínica asociada (filas en
--     cardiolink_hc_evoluciones/hc_resumen o referencias en las claves clínicas heredadas) → 42501. Elementos heredados sin id utilizable se conservan.
--   * profesionales: por id. Quitar uno con identidad documental cargada → 42501 (lo hace el dueño). Un profesional nuevo entra sin identidad.
--   * auditoriaPacientes: sólo se AGREGAN elementos nuevos.
--   * Se conservan payload.tipoRegistro y payload.version; se actualiza payload.updatedAt y la columna updated_at.
-- CONCURRENCIA. El cliente manda el `updated_at` y el `vista_hash` que recibió al leer. El hash cubre SÓLO lo que Secretaría puede sobrescribir (claves de
--   escritura con sus campos anidados permitidos). Si la fila cambió (updated_at distinto) Y ese contenido también (hash distinto) → {ok:false, conflict:true}
--   sin escribir nada. Si la fila cambió por escrituras clínicas, de identidad o de usuarios (hash igual), se acepta: evita conflictos falsos.
--   La fila se bloquea (FOR UPDATE). El cliente serializa sus llamadas para no competir contra sí mismo.
-- No modifica: tablas, columnas, políticas RLS, triggers, datos ni otras funciones. No borra nada.
-- Interacción con el trigger de identidad (cardiolink_atenciones_proteger_identidad_v1, si está aplicado): el UPDATE de estas RPC corre como el dueño de la
--   función (no authenticated), por lo que el trigger no interviene; la identidad se protege acá preservándola.

BEGIN;

DO $$
DECLARE v_tipo text;
BEGIN
  IF to_regclass('public.cardiolink_atenciones') IS NULL THEN RAISE EXCEPTION 'Precondición: falta public.cardiolink_atenciones'; END IF;
  IF to_regclass('public.cardiolink_user_roles') IS NULL THEN RAISE EXCEPTION 'Precondición: falta public.cardiolink_user_roles'; END IF;
  IF to_regclass('public.cardiolink_hc_evoluciones') IS NULL OR to_regclass('public.cardiolink_hc_resumen') IS NULL THEN
    RAISE EXCEPTION 'Precondición: faltan las tablas de HC relacional (cardiolink_hc_evoluciones / cardiolink_hc_resumen)'; END IF;
  SELECT data_type INTO v_tipo FROM information_schema.columns
   WHERE table_schema='public' AND table_name='cardiolink_atenciones' AND column_name='updated_at';
  IF v_tipo IS DISTINCT FROM 'timestamp with time zone' THEN
    RAISE EXCEPTION 'Precondición: cardiolink_atenciones.updated_at debe ser timestamptz (es %)', v_tipo; END IF;
  IF (SELECT relforcerowsecurity FROM pg_class WHERE oid='public.cardiolink_atenciones'::regclass) THEN
    RAISE EXCEPTION 'Precondición: cardiolink_atenciones tiene FORCE ROW LEVEL SECURITY; las RPC SECURITY DEFINER no podrían actualizar la fila'; END IF;
  IF (SELECT count(*) FROM public.cardiolink_atenciones WHERE id='__cardiolink_config_v1') <> 1 THEN
    RAISE EXCEPTION 'Precondición: debe existir exactamente una fila __cardiolink_config_v1'; END IF;
  IF to_regprocedure('public.cardiolink_config_administrativa_v1()') IS NOT NULL
     OR to_regprocedure('public.cardiolink_guardar_config_administrativa_v1(jsonb,text,text,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Las RPC ya existen: no se repite esta etapa'; END IF;
END $$;

-- ===== 1) Listas explícitas (internas; sin acceso de authenticated) =====
CREATE FUNCTION public.cardiolink_config_claves_lectura_sec_v1()
 RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT ARRAY[
  -- CLAVES_LECTURA_INICIO
  'profesionales','especialidades','obrasSociales','reglasOS','pacientes','usuarios','roles','colocadores',
  'medicosDerivantes','motivosConsulta','bloquesPrestaciones','bloquesPrestacionesLabels','horariosProfesionales',
  'arancelesPorProfesional','conveniosPorProfesional','conveniosFacturacion','arancelesConvenios','plantillasPedidos',
  'duracionesPrestacion','catalogoPrestaciones411P','destinosFacturacion','brandingCardioLink','auditoriaPacientes',
  'migracionesCardioLink','documentosClinicos'
  -- CLAVES_LECTURA_FIN
 ]::text[]
$f$;

CREATE FUNCTION public.cardiolink_config_claves_escritura_sec_v1()
 RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT ARRAY[
  -- CLAVES_ESCRITURA_INICIO
  'profesionales','especialidades','obrasSociales','reglasOS','pacientes','colocadores',
  'medicosDerivantes','motivosConsulta','bloquesPrestaciones','bloquesPrestacionesLabels','horariosProfesionales',
  'arancelesPorProfesional','conveniosPorProfesional','conveniosFacturacion','arancelesConvenios','plantillasPedidos',
  'duracionesPrestacion','catalogoPrestaciones411P','destinosFacturacion','auditoriaPacientes'
  -- CLAVES_ESCRITURA_FIN
 ]::text[]
$f$;

-- Claves de identidad documental del profesional (las mismas 12 que protege el trigger de identidad y escribe cardiolink_guardar_identidad_profesional_v1).
CREATE FUNCTION public.cardiolink_config_claves_identidad_v1()
 RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT ARRAY[
  -- CAMPOS_IDENTIDAD_INICIO
  'marcaDocumento','logoDocumento','logoDocumentoData','firmaDocumentoData','matriculaNacional','matriculaProvincial',
  'telefonoDocumento','emailDocumento','direccionDocumento','redesDocumento','colorDocumento','mostrarFirmaDocumento'
  -- CAMPOS_IDENTIDAD_FIN
 ]::text[]
$f$;

-- Campos administrativos de cada elemento de pacientes[] (lectura y escritura). Estructura relevada de aplicarPaciente298, pacienteRow410, mergePaciente410 y fusionarPacientes.
CREATE FUNCTION public.cardiolink_config_campos_paciente_v1()
 RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT ARRAY[
  -- CAMPOS_PACIENTE_INICIO
  'id','nombreCompleto','dni','sexo','telefono','email','fechaNacimiento','localidad','direccion','provincia',
  'coberturaHabitual','numeroAfiliadoHabitual','historialCoberturas','contactoResponsableNombre','contactoResponsableRelacion',
  'contactoResponsableTelefono','contactoResponsableEmail','observacionesAdministrativas','estado','fusionadoCon','fusionadoEn',
  'fusionadoPor','creadoEn','creadoPor','actualizadoEn','actualizadoPor','creadoPorImportacionLote'
  -- CAMPOS_PACIENTE_FIN
 ]::text[]
$f$;

-- Campos administrativos de cada elemento de profesionales[] que Secretaría puede ESCRIBIR (la identidad documental nunca).
CREATE FUNCTION public.cardiolink_config_campos_profesional_admin_v1()
 RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT ARRAY[
  -- CAMPOS_PROFESIONAL_INICIO
  'id','nombre','area','prestaciones','valores','especialidadIds','bloquesPrestaciones','activo'
  -- CAMPOS_PROFESIONAL_FIN
 ]::text[]
$f$;

-- Tipos de documento heredado que Secretaría puede LEER (sólo lectura; nunca se escriben por esta vía).
CREATE FUNCTION public.cardiolink_config_tipos_doc_sec_v1()
 RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT ARRAY[
  -- TIPOS_DOC_INICIO
  'constancia_atencion'
  -- TIPOS_DOC_FIN
 ]::text[]
$f$;

-- ===== 2) Filtros y vistas =====
-- Cada elemento-objeto de un arreglo, reducido a los campos indicados (los que no son objeto se descartan).
CREATE FUNCTION public.cardiolink_config_filtrar_objetos_v1(p_arr jsonb, p_campos text[])
 RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT coalesce(jsonb_agg(s.f ORDER BY s.ord), '[]'::jsonb)
   FROM (SELECT e.ord,
                coalesce((SELECT jsonb_object_agg(k, e.p -> k) FROM unnest(p_campos) AS k WHERE e.p ? k), '{}'::jsonb) AS f
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_arr) = 'array' THEN p_arr ELSE '[]'::jsonb END) WITH ORDINALITY AS e(p, ord)
          WHERE jsonb_typeof(e.p) = 'object') s
$f$;

-- Vista de LECTURA: sólo las claves de lectura; pacientes y profesionales con campos anidados filtrados; documentos filtrados por tipo.
CREATE FUNCTION public.cardiolink_config_vista_sec_v1(p_config jsonb)
 RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT coalesce(jsonb_object_agg(k,
          CASE
            WHEN k = 'pacientes' AND jsonb_typeof(p_config -> k) = 'array'
              THEN public.cardiolink_config_filtrar_objetos_v1(p_config -> k, public.cardiolink_config_campos_paciente_v1())
            WHEN k = 'profesionales' AND jsonb_typeof(p_config -> k) = 'array'
              THEN public.cardiolink_config_filtrar_objetos_v1(p_config -> k,
                     public.cardiolink_config_campos_profesional_admin_v1() || public.cardiolink_config_claves_identidad_v1())
            WHEN k = 'documentosClinicos' AND jsonb_typeof(p_config -> k) = 'array'
              THEN coalesce((SELECT jsonb_agg(d.x ORDER BY d.ord)
                               FROM jsonb_array_elements(p_config -> k) WITH ORDINALITY AS d(x, ord)
                              WHERE jsonb_typeof(d.x) = 'object' AND (d.x ->> 'tipo') = ANY (public.cardiolink_config_tipos_doc_sec_v1())), '[]'::jsonb)
            ELSE p_config -> k
          END) FILTER (WHERE p_config ? k), '{}'::jsonb)
   FROM unnest(public.cardiolink_config_claves_lectura_sec_v1()) AS k
$f$;

-- Vista de ESCRITURA (para el hash de concurrencia): lo que Secretaría puede sobrescribir, con los campos anidados permitidos.
CREATE FUNCTION public.cardiolink_config_vista_escritura_sec_v1(p_config jsonb)
 RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT coalesce(jsonb_object_agg(k,
          CASE
            WHEN k = 'pacientes' AND jsonb_typeof(p_config -> k) = 'array'
              THEN public.cardiolink_config_filtrar_objetos_v1(p_config -> k, public.cardiolink_config_campos_paciente_v1())
            WHEN k = 'profesionales' AND jsonb_typeof(p_config -> k) = 'array'
              THEN public.cardiolink_config_filtrar_objetos_v1(p_config -> k, public.cardiolink_config_campos_profesional_admin_v1())
            ELSE p_config -> k
          END) FILTER (WHERE p_config ? k), '{}'::jsonb)
   FROM unnest(public.cardiolink_config_claves_escritura_sec_v1()) AS k
$f$;

-- ¿El paciente tiene historia clínica asociada? (tablas relacionales o claves clínicas heredadas). Se usa para impedir que Secretaría lo quite.
CREATE FUNCTION public.cardiolink_config_paciente_con_clinica_v1(p_cfg jsonb, p_id text)
 RETURNS boolean LANGUAGE sql STABLE
 SET search_path TO 'pg_catalog', 'public'
AS $f$
 SELECT EXISTS (SELECT 1 FROM public.cardiolink_hc_evoluciones r WHERE r.paciente_id = p_id)
     OR EXISTS (SELECT 1 FROM public.cardiolink_hc_resumen r WHERE r.paciente_id = p_id)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_cfg -> 'evolucionesClinicas') = 'array' THEN p_cfg -> 'evolucionesClinicas' ELSE '[]'::jsonb END) e(x)
                 WHERE e.x ->> 'pacienteId' = p_id)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_cfg -> 'documentosClinicos') = 'array' THEN p_cfg -> 'documentosClinicos' ELSE '[]'::jsonb END) e(x)
                 WHERE e.x ->> 'pacienteId' = p_id)
     OR (CASE WHEN jsonb_typeof(p_cfg -> 'resumenesClinicos') = 'object' THEN (p_cfg -> 'resumenesClinicos') ? p_id ELSE false END)
$f$;

-- ===== 3) Fusiones anidadas =====
-- pacientes: parte del elemento EXISTENTE y pisa sólo los campos administrativos enviados; un paciente nuevo entra sólo con campos administrativos.
CREATE FUNCTION public.cardiolink_config_fusionar_pacientes_v1(p_old jsonb, p_in jsonb, p_cfg jsonb)
 RETURNS jsonb LANGUAGE plpgsql STABLE
 SET search_path TO 'pg_catalog', 'public'
AS $f$
DECLARE
  c_campos constant text[] := public.cardiolink_config_campos_paciente_v1();
  v_old    jsonb := CASE WHEN jsonb_typeof(p_old) = 'array' THEN p_old ELSE '[]'::jsonb END;
  v_res    jsonb;
  v_o      jsonb;
BEGIN
  IF jsonb_typeof(p_in) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'pacientes debe ser un arreglo' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_in) e(p) WHERE jsonb_typeof(e.p) <> 'object' OR nullif(e.p ->> 'id', '') IS NULL) THEN
    RAISE EXCEPTION 'pacientes: todos los elementos deben ser objetos con id' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_in) e(p) GROUP BY e.p ->> 'id' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'pacientes: ids duplicados' USING ERRCODE = '22023'; END IF;
  -- bajas: no se quita un paciente con historia clínica asociada
  FOR v_o IN
    SELECT o.p FROM jsonb_array_elements(v_old) o(p)
     WHERE jsonb_typeof(o.p) = 'object' AND nullif(o.p ->> 'id', '') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_in) n(p) WHERE n.p ->> 'id' = o.p ->> 'id')
  LOOP
    IF public.cardiolink_config_paciente_con_clinica_v1(p_cfg, v_o ->> 'id') THEN
      RAISE EXCEPTION 'No se puede quitar el paciente % desde Secretaría: tiene historia clínica asociada (lo hace el dueño)', v_o ->> 'id' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  SELECT coalesce(jsonb_agg(m.x ORDER BY m.ord), '[]'::jsonb) INTO v_res
    FROM (SELECT n.ord,
                 coalesce(o.p, '{}'::jsonb)
                 || coalesce((SELECT jsonb_object_agg(k, n.p -> k) FROM unnest(c_campos) AS k WHERE n.p ? k), '{}'::jsonb) AS x
            FROM jsonb_array_elements(p_in) WITH ORDINALITY AS n(p, ord)
            LEFT JOIN LATERAL (SELECT oo.p FROM jsonb_array_elements(v_old) AS oo(p)
                                WHERE jsonb_typeof(oo.p) = 'object' AND oo.p ->> 'id' = n.p ->> 'id' LIMIT 1) AS o ON true) m;
  -- elementos heredados sin id utilizable: se conservan al final (no se elimina nada que Secretaría no pueda ver)
  v_res := v_res || coalesce((SELECT jsonb_agg(o.p ORDER BY o.ord)
                                FROM jsonb_array_elements(v_old) WITH ORDINALITY AS o(p, ord)
                               WHERE jsonb_typeof(o.p) <> 'object' OR nullif(o.p ->> 'id', '') IS NULL), '[]'::jsonb);
  RETURN v_res;
END
$f$;

-- profesionales: parte del elemento EXISTENTE y pisa sólo los campos administrativos enviados; la identidad documental no se toca nunca.
CREATE FUNCTION public.cardiolink_config_fusionar_profesionales_v1(p_old jsonb, p_in jsonb)
 RETURNS jsonb LANGUAGE plpgsql IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $f$
DECLARE
  c_ident  constant text[] := public.cardiolink_config_claves_identidad_v1();
  c_campos constant text[] := public.cardiolink_config_campos_profesional_admin_v1();
  v_old    jsonb := CASE WHEN jsonb_typeof(p_old) = 'array' THEN p_old ELSE '[]'::jsonb END;
  v_res    jsonb;
  v_o      jsonb;
BEGIN
  IF jsonb_typeof(p_in) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'profesionales debe ser un arreglo' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_in) e(p) WHERE jsonb_typeof(e.p) <> 'object' OR nullif(e.p ->> 'id', '') IS NULL) THEN
    RAISE EXCEPTION 'profesionales: todos los elementos deben ser objetos con id' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_in) e(p) GROUP BY e.p ->> 'id' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'profesionales: ids duplicados' USING ERRCODE = '22023'; END IF;
  -- no se quita un profesional que tiene identidad documental cargada
  FOR v_o IN
    SELECT o.p FROM jsonb_array_elements(v_old) o(p)
     WHERE jsonb_typeof(o.p) = 'object' AND nullif(o.p ->> 'id', '') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_in) n(p) WHERE n.p ->> 'id' = o.p ->> 'id')
  LOOP
    IF EXISTS (SELECT 1 FROM unnest(c_ident) k WHERE jsonb_typeof(v_o -> k) = 'string' AND (v_o ->> k) <> '') THEN
      RAISE EXCEPTION 'No se puede quitar el profesional % desde Secretaría: tiene identidad documental cargada (lo hace el dueño)', v_o ->> 'id'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
  SELECT coalesce(jsonb_agg(m.x ORDER BY m.ord), '[]'::jsonb) INTO v_res
    FROM (SELECT n.ord,
                 coalesce(o.p, '{}'::jsonb)
                 || coalesce((SELECT jsonb_object_agg(k, n.p -> k) FROM unnest(c_campos) AS k WHERE n.p ? k), '{}'::jsonb) AS x
            FROM jsonb_array_elements(p_in) WITH ORDINALITY AS n(p, ord)
            LEFT JOIN LATERAL (SELECT oo.p FROM jsonb_array_elements(v_old) AS oo(p)
                                WHERE jsonb_typeof(oo.p) = 'object' AND oo.p ->> 'id' = n.p ->> 'id' LIMIT 1) AS o ON true) m;
  v_res := v_res || coalesce((SELECT jsonb_agg(o.p ORDER BY o.ord)
                                FROM jsonb_array_elements(v_old) WITH ORDINALITY AS o(p, ord)
                               WHERE jsonb_typeof(o.p) <> 'object' OR nullif(o.p ->> 'id', '') IS NULL), '[]'::jsonb);
  RETURN v_res;
END
$f$;

-- auditoriaPacientes: conserva los existentes (y su orden) y agrega los nuevos.
CREATE FUNCTION public.cardiolink_config_unir_auditoria_v1(p_old jsonb, p_in jsonb)
 RETURNS jsonb LANGUAGE plpgsql IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $f$
DECLARE
  v_old jsonb := CASE WHEN jsonb_typeof(p_old) = 'array' THEN p_old ELSE '[]'::jsonb END;
BEGIN
  IF jsonb_typeof(p_in) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'auditoriaPacientes debe ser un arreglo' USING ERRCODE = '22023'; END IF;
  RETURN v_old || coalesce((SELECT jsonb_agg(e.x ORDER BY e.ord)
                              FROM jsonb_array_elements(p_in) WITH ORDINALITY AS e(x, ord)
                             WHERE NOT (v_old @> jsonb_build_array(e.x))), '[]'::jsonb);
END
$f$;

-- ===== 4) RPC de lectura =====
CREATE FUNCTION public.cardiolink_config_administrativa_v1()
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $f$
DECLARE
  v_row public.cardiolink_atenciones%ROWTYPE;
  v_cfg jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.cardiolink_user_roles r
                                        WHERE r.user_id = auth.uid() AND r.active IS TRUE AND r.base_role = 'secretaria') THEN
    RAISE EXCEPTION 'Sin permiso para ver la configuración administrativa' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM public.cardiolink_atenciones WHERE id = '__cardiolink_config_v1';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'config', NULL, 'updated_at', NULL, 'vista_hash', NULL);
  END IF;
  v_cfg := CASE WHEN jsonb_typeof(v_row.payload -> 'config') = 'object' THEN v_row.payload -> 'config' ELSE '{}'::jsonb END;
  RETURN jsonb_build_object('ok', true, 'config', public.cardiolink_config_vista_sec_v1(v_cfg), 'updated_at', v_row.updated_at::text,
                            'vista_hash', md5(public.cardiolink_config_vista_escritura_sec_v1(v_cfg)::text), 'version', v_row.payload -> 'version');
END
$f$;

-- ===== 5) RPC de escritura =====
CREATE FUNCTION public.cardiolink_guardar_config_administrativa_v1(p_config jsonb, p_base_updated_at text, p_base_hash text, p_uid_esperado uuid)
 RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $f$
DECLARE
  v_row     public.cardiolink_atenciones%ROWTYPE;
  v_cfg     jsonb;
  v_new     jsonb;
  v_in      jsonb;
  v_old     jsonb;
  v_hash    text;
  v_base_ts timestamptz;
  v_now     timestamptz := clock_timestamp();
  v_upd     timestamptz;
  k         text;
BEGIN
  -- Cambio de sesión (v3.1): p_uid_esperado es OBLIGATORIO (sin DEFAULT: omitirlo = la función no existe para esa llamada, 42883) y no puede ser NULL.
  -- La operación pertenece al usuario que la inició: si el token que llega es de otro usuario (o no hay sesión), no se escribe.
  IF p_uid_esperado IS NULL THEN
    RAISE EXCEPTION 'Falta el usuario que inició el guardado (p_uid_esperado)' USING ERRCODE = '22023', HINT = 'UID_ESPERADO_OBLIGATORIO';
  END IF;
  IF auth.uid() IS NULL OR p_uid_esperado IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'La sesión que inició este guardado ya no es la activa: no se guardó nada' USING ERRCODE = '42501', HINT = 'SESION_DISTINTA';
  END IF;
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.cardiolink_user_roles r
                                        WHERE r.user_id = auth.uid() AND r.active IS TRUE AND r.base_role = 'secretaria') THEN
    RAISE EXCEPTION 'Sin permiso para guardar la configuración administrativa' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_config) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'La configuración debe ser un objeto' USING ERRCODE = '22023'; END IF;
  IF p_base_updated_at IS NULL OR btrim(p_base_updated_at) = '' THEN
    RAISE EXCEPTION 'Falta la versión base (updated_at) de la configuración' USING ERRCODE = '22023'; END IF;
  BEGIN v_base_ts := p_base_updated_at::timestamptz;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'Versión base inválida' USING ERRCODE = '22023'; END;

  SELECT * INTO v_row FROM public.cardiolink_atenciones WHERE id = '__cardiolink_config_v1' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'sin_configuracion'); END IF;
  v_cfg  := CASE WHEN jsonb_typeof(v_row.payload -> 'config') = 'object' THEN v_row.payload -> 'config' ELSE '{}'::jsonb END;
  v_hash := md5(public.cardiolink_config_vista_escritura_sec_v1(v_cfg)::text);

  -- Concurrencia: la fila cambió Y lo que Secretaría puede sobrescribir también → conflicto, sin escribir.
  IF v_row.updated_at IS DISTINCT FROM v_base_ts AND v_hash IS DISTINCT FROM p_base_hash THEN
    RETURN jsonb_build_object('ok', false, 'conflict', true, 'updated_at', v_row.updated_at::text, 'vista_hash', v_hash);
  END IF;

  v_new := v_cfg;
  FOREACH k IN ARRAY public.cardiolink_config_claves_escritura_sec_v1() LOOP
    CONTINUE WHEN NOT (p_config ? k);
    v_in  := p_config -> k;
    v_old := v_cfg -> k;
    IF jsonb_typeof(v_in) IS NULL OR jsonb_typeof(v_in) = 'null' THEN
      RAISE EXCEPTION 'La clave % no puede ser null', k USING ERRCODE = '22023'; END IF;
    IF v_old IS NOT NULL AND jsonb_typeof(v_old) <> 'null' AND jsonb_typeof(v_in) <> jsonb_typeof(v_old) THEN
      RAISE EXCEPTION 'La clave % cambia de tipo (%→%)', k, jsonb_typeof(v_old), jsonb_typeof(v_in) USING ERRCODE = '22023'; END IF;
    IF k IN ('pacientes', 'profesionales', 'obrasSociales')
       AND coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(v_in)  = 'array' THEN v_in  END), -1) = 0
       AND coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(v_old) = 'array' THEN v_old END),  0) > 0 THEN
      RAISE EXCEPTION 'La clave % llegó vacía y la configuración tiene datos: se rechaza para evitar un vaciado accidental', k USING ERRCODE = '22023'; END IF;
    IF k = 'pacientes' THEN v_in := public.cardiolink_config_fusionar_pacientes_v1(v_old, v_in, v_cfg);
    ELSIF k = 'profesionales' THEN v_in := public.cardiolink_config_fusionar_profesionales_v1(v_old, v_in);
    ELSIF k = 'auditoriaPacientes' THEN v_in := public.cardiolink_config_unir_auditoria_v1(v_old, v_in);
    END IF;
    v_new := jsonb_set(v_new, ARRAY[k], v_in, true);
  END LOOP;

  UPDATE public.cardiolink_atenciones
     SET payload = jsonb_set(jsonb_set(v_row.payload, '{config}', v_new, true), '{updatedAt}',
                             to_jsonb(to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), true),
         updated_at = v_now
   WHERE id = '__cardiolink_config_v1'
   RETURNING updated_at INTO v_upd;

  RETURN jsonb_build_object('ok', true, 'updated_at', v_upd::text,
                            'vista_hash', md5(public.cardiolink_config_vista_escritura_sec_v1(v_new)::text));
END
$f$;

-- ===== 6) Privilegios =====
REVOKE ALL ON FUNCTION public.cardiolink_config_claves_lectura_sec_v1()   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_claves_escritura_sec_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_claves_identidad_v1()     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_campos_paciente_v1()      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_campos_profesional_admin_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_tipos_doc_sec_v1()        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_filtrar_objetos_v1(jsonb,text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_vista_sec_v1(jsonb)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_vista_escritura_sec_v1(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_paciente_con_clinica_v1(jsonb,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_fusionar_pacientes_v1(jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_fusionar_profesionales_v1(jsonb,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_unir_auditoria_v1(jsonb,jsonb)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_administrativa_v1()                    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cardiolink_guardar_config_administrativa_v1(jsonb,text,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_config_administrativa_v1()                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_guardar_config_administrativa_v1(jsonb,text,text,uuid) TO authenticated;

-- ===== 7) Postcondiciones =====
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.cardiolink_config_administrativa_v1()','public.cardiolink_guardar_config_administrativa_v1(jsonb,text,text,uuid)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN RAISE EXCEPTION 'FALLA: anon puede ejecutar %', f; END IF;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN RAISE EXCEPTION 'FALLA: authenticated no puede ejecutar %', f; END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure) THEN RAISE EXCEPTION 'FALLA: % no es SECURITY DEFINER', f; END IF;
  END LOOP;
  IF (SELECT pronargdefaults FROM pg_proc WHERE oid = 'public.cardiolink_guardar_config_administrativa_v1(jsonb,text,text,uuid)'::regprocedure) <> 0 THEN
    RAISE EXCEPTION 'FALLA: la RPC de guardado no debe tener argumentos por defecto (p_uid_esperado es obligatorio)'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'cardiolink_guardar_config_administrativa_v1') <> 1 THEN
    RAISE EXCEPTION 'FALLA: debe existir una única firma de la RPC de guardado'; END IF;
  FOREACH f IN ARRAY ARRAY['public.cardiolink_config_claves_lectura_sec_v1()','public.cardiolink_config_claves_escritura_sec_v1()',
                           'public.cardiolink_config_claves_identidad_v1()','public.cardiolink_config_campos_paciente_v1()',
                           'public.cardiolink_config_campos_profesional_admin_v1()','public.cardiolink_config_tipos_doc_sec_v1()',
                           'public.cardiolink_config_filtrar_objetos_v1(jsonb,text[])','public.cardiolink_config_vista_sec_v1(jsonb)',
                           'public.cardiolink_config_vista_escritura_sec_v1(jsonb)','public.cardiolink_config_paciente_con_clinica_v1(jsonb,text)',
                           'public.cardiolink_config_fusionar_pacientes_v1(jsonb,jsonb,jsonb)','public.cardiolink_config_fusionar_profesionales_v1(jsonb,jsonb)',
                           'public.cardiolink_config_unir_auditoria_v1(jsonb,jsonb)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'FALLA: el helper interno % es ejecutable por anon/authenticated', f; END IF;
  END LOOP;
  IF public.cardiolink_config_claves_escritura_sec_v1() <@ public.cardiolink_config_claves_lectura_sec_v1() IS NOT TRUE THEN
    RAISE EXCEPTION 'FALLA: la lista de escritura debe estar contenida en la de lectura'; END IF;
  IF 'documentosClinicos' = ANY (public.cardiolink_config_claves_escritura_sec_v1()) THEN
    RAISE EXCEPTION 'FALLA: documentosClinicos no puede ser escribible por Secretaría'; END IF;
  IF public.cardiolink_config_claves_lectura_sec_v1() && ARRAY['evolucionesClinicas','resumenesClinicos','importacionesMedicloudEvoluciones',
       'notasInternasMedicas','notasInternasPorProfesional','configFinanzas411F','movimientosFinancieros411C','hcPreparacion','integracionesClinicas','identidadesArchivadas'] THEN
    RAISE EXCEPTION 'FALLA: la lista de lectura incluye una clave restringida'; END IF;
  IF public.cardiolink_config_campos_profesional_admin_v1() && public.cardiolink_config_claves_identidad_v1() THEN
    RAISE EXCEPTION 'FALLA: un campo de identidad figura entre los campos administrativos escribibles del profesional'; END IF;
  RAISE NOTICE 'OK ETAPA A: RPC creadas, helpers internos cerrados, listas coherentes. Ninguna política ni dato se modificó.';
END $$;

COMMIT;
