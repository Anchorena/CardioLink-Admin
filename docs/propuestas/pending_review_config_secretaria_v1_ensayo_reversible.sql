-- CardioLink · Seguridad clinica V1 / Bloque 4B · ENSAYO REVERSIBLE (v3.1)   -- ARCHIVO GENERADO: no editar a mano (ver ..._generar_ensayo.sh)
-- SOLO STAGING (yslhwdlzdknhskawqrtv). NO EJECUTAR sin autorizacion explicita. NUNCA en Production.
--
-- QUE HACE: en UNA sola transaccion instala TEMPORALMENTE las funciones de la ETAPA A y las politicas/predicado de la ETAPA B, corre el QA SQL completo
-- y termina con ROLLBACK. Despues, en la misma sesion, verifica en una sola fila que NO quedo nada: ni funciones, ni politica, ni predicado modificado,
-- ni filas sinteticas, ni la fila de configuracion heredada alterada.
-- NO hay COMMIT en este archivo. Los SQL de origen se incluyen SIN su BEGIN/COMMIT (si no, cada COMMIT haria permanente lo instalado).
-- La verificacion final NO depende de objetos creados antes de la transaccion (un cliente que envia todo el script como una sola consulta los
-- incluiria en la misma transaccion y el ROLLBACK los borraria): compara contra valores absolutos (el cuerpo previo del predicado, los marcadores del fixture).
--
-- PRECONDICIONES: las ETAPAS A y B NO estan aplicadas (si lo estan, el script se detiene sin hacer nada). Hay 1 secretaria, 1 owner/admin y 1 medico activos.
-- DURANTE EL ENSAYO: DDL sobre cardiolink_atenciones mantiene bloqueos hasta el ROLLBACK (segundos): ejecutar sin trafico (fuera del horario de uso).
-- RESULTADO: la ULTIMA sentencia devuelve UNA fila con el veredicto ('ENSAYO OK'). Si una prueba falla, el script se detiene con un mensaje 'FALLA ...' y la
-- transaccion queda abortada: ejecutar ROLLBACK; (no se persiste nada). Terminar SIN error significa que TODAS las pruebas pasaron (cada una lanza una excepcion si falla).
-- Procedimiento: pending_review_config_secretaria_v1_ensayo_reversible_procedimiento.md
-- SIN EJECUTAR: sintaxis sin validar contra una base.

-- ===== PASO 0: guarda de seguridad (no hace ningun cambio) =====
DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_config_administrativa_v1()') IS NOT NULL
     OR to_regprocedure('public.cardiolink_guardar_config_administrativa_v1(jsonb,text,text,uuid)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones' AND policyname='cardiolink_atenciones_config_solo_admin_v1') THEN
    RAISE EXCEPTION 'El ensayo requiere las etapas A y B SIN aplicar (ya existen funciones o la politica). No se hizo nada.';
  END IF;
END $$;

-- ===== TRANSACCION DEL ENSAYO =====
BEGIN;

-- ---------- ETAPA A (pending_review_config_secretaria_v1_a_rpc.sql, sin su BEGIN/COMMIT) ----------
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


-- ---------- ETAPA B (pending_review_config_secretaria_v1_b_rls.sql, sin su BEGIN/COMMIT) ----------
-- CardioLink · Seguridad clínica V1 / Bloque 4B · ETAPA B (RLS): cerrar la fila de configuración completa a Secretaría
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita. SOLO STAGING (yslhwdlzdknhskawqrtv).
-- Rollback: pending_review_config_secretaria_v1_b_rls_rollback.sql. Pruebas: pending_review_config_secretaria_v1_tests.sql.
-- SIN EJECUTAR: sintaxis sin validar contra una base (no hay Postgres local).
--
-- ORDEN OBLIGATORIO. Aplicar SÓLO DESPUÉS de (1) la ETAPA A y (2) que el cliente de Secretaría con las RPC esté desplegado y verificado.
-- Si se aplica antes, un cliente viejo de Secretaría pierde el guardado de configuración (42501; el cliente viejo sólo hace console.warn).
--
-- QUÉ HACE (y nada más):
--   1) cardiolink_atencion_permitida_v2: la rama 'secretaria' deja de ser `true` y pasa a `tipoRegistro <> 'config'`.
--      Las 4 políticas existentes (SELECT/INSERT/UPDATE/DELETE) ya evalúan este predicado, así que Secretaría deja de poder leer, insertar,
--      modificar o borrar la fila de configuración por API directa (y de convertir otra fila en 'config'). Atenciones y mensajes: sin cambios.
--      owner/admin: igual que antes (true). médico: igual que antes (sin cambios de lógica).
--   2) Política RESTRICTIVA por id (cinturón y tirantes, independiente del contenido del payload): la fila '__cardiolink_config_v1' sólo es
--      accesible, por API, para owner/admin. Una política RESTRICTIVA se suma (AND) a las permisivas existentes; no abre nada.
-- Las RPC de la ETAPA A siguen funcionando: son SECURITY DEFINER (corren como dueño de la tabla, sin RLS).
-- No modifica datos, tablas, columnas, triggers, grants ni otras funciones. No borra nada. La fila de configuración y su contenido quedan intactos.
-- Efecto colateral aceptado: un cliente viejo de Secretaría (sin las RPC) deja de poder leer/guardar la config; ver riesgos en el informe.


DO $$
DECLARE v_src text; v_esperado constant text :=
  regexp_replace($e$
 SELECT CASE
   WHEN p_rol IN ('owner','admin','secretaria') THEN true
   WHEN p_rol = 'medico' THEN nullif(pg_catalog.btrim(p_prof),'') IS NOT NULL
        AND p_prof = p_payload->>'profesionalId'
        AND coalesce(p_payload->>'tipoRegistro','') NOT IN ('mensaje','config')
   ELSE false END
$e$, '\s+', '', 'g');
  n int;
BEGIN
  IF to_regprocedure('public.cardiolink_config_administrativa_v1()') IS NULL
     OR to_regprocedure('public.cardiolink_guardar_config_administrativa_v1(jsonb,text,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Precondición: aplicar antes la ETAPA A (RPC de configuración administrativa)'; END IF;
  IF to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL THEN RAISE EXCEPTION 'Precondición: falta cardiolink_ctx_rol_v1()'; END IF;
  SELECT regexp_replace(prosrc, '\s+', '', 'g') INTO v_src FROM pg_proc WHERE oid = 'public.cardiolink_atencion_permitida_v2(jsonb,text,text)'::regprocedure;
  IF v_src IS DISTINCT FROM v_esperado THEN
    RAISE EXCEPTION 'Precondición: el cuerpo vigente de cardiolink_atencion_permitida_v2 no coincide con el esperado (comparar con el snapshot de la consulta 1 de la auditoría)'; END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones'
     AND (coalesce(qual,'') ~ 'cardiolink_atencion_permitida_v2' OR coalesce(with_check,'') ~ 'cardiolink_atencion_permitida_v2');
  IF n < 4 THEN RAISE EXCEPTION 'Precondición: se esperaban 4 políticas que usen cardiolink_atencion_permitida_v2 y hay %', n; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones' AND policyname='cardiolink_atenciones_config_solo_admin_v1') THEN
    RAISE EXCEPTION 'La política restrictiva ya existe: no se repite esta etapa'; END IF;
END $$;

-- ===== 1) Predicado v2 (nueva versión): Secretaría no accede a filas de configuración =====
CREATE OR REPLACE FUNCTION public.cardiolink_atencion_permitida_v2(p_payload jsonb, p_rol text, p_prof text)
 RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT CASE
   WHEN p_rol IN ('owner','admin') THEN true
   WHEN p_rol = 'secretaria' THEN coalesce(p_payload->>'tipoRegistro','') <> 'config'
   WHEN p_rol = 'medico' THEN nullif(pg_catalog.btrim(p_prof),'') IS NOT NULL
        AND p_prof = p_payload->>'profesionalId'
        AND coalesce(p_payload->>'tipoRegistro','') NOT IN ('mensaje','config')
   ELSE false END
$f$;
-- CREATE OR REPLACE conserva los GRANT existentes (EXECUTE sólo para authenticated, no anon).

-- ===== 2) Política RESTRICTIVA por id =====
CREATE POLICY cardiolink_atenciones_config_solo_admin_v1 ON public.cardiolink_atenciones
  AS RESTRICTIVE FOR ALL TO authenticated
  USING      (id <> '__cardiolink_config_v1' OR (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner','admin'))
  WITH CHECK (id <> '__cardiolink_config_v1' OR (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner','admin'));

-- ===== 3) Postcondiciones =====
DO $$
BEGIN
  IF public.cardiolink_atencion_permitida_v2('{"tipoRegistro":"config"}'::jsonb,'secretaria',NULL) IS NOT FALSE THEN RAISE EXCEPTION 'FALLA: secretaria aún accede a config'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"tipoRegistro":"config"}'::jsonb,'owner',NULL)      IS NOT TRUE  THEN RAISE EXCEPTION 'FALLA: owner perdió acceso a config'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"tipoRegistro":"config"}'::jsonb,'admin',NULL)      IS NOT TRUE  THEN RAISE EXCEPTION 'FALLA: admin perdió acceso a config'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"id":"1","profesionalId":"x"}'::jsonb,'secretaria',NULL) IS NOT TRUE THEN RAISE EXCEPTION 'FALLA: secretaria perdió las atenciones'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"tipoRegistro":"mensaje"}'::jsonb,'secretaria',NULL) IS NOT TRUE THEN RAISE EXCEPTION 'FALLA: secretaria perdió los mensajes'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"profesionalId":"x"}'::jsonb,'medico','x') IS NOT TRUE THEN RAISE EXCEPTION 'FALLA: médico perdió sus atenciones'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"profesionalId":"x"}'::jsonb,'medico','y') IS NOT FALSE THEN RAISE EXCEPTION 'FALLA: médico ve atenciones ajenas'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"tipoRegistro":"config","profesionalId":"x"}'::jsonb,'medico','x') IS NOT FALSE THEN RAISE EXCEPTION 'FALLA: médico accede a config'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{}'::jsonb,'otro','x') IS NOT FALSE THEN RAISE EXCEPTION 'FALLA: rol desconocido con acceso'; END IF;
  IF has_function_privilege('anon','public.cardiolink_atencion_permitida_v2(jsonb,text,text)','EXECUTE') THEN RAISE EXCEPTION 'FALLA: anon puede ejecutar el predicado'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones'
                  AND policyname='cardiolink_atenciones_config_solo_admin_v1' AND permissive='RESTRICTIVE') THEN
    RAISE EXCEPTION 'FALLA: no existe la política restrictiva'; END IF;
  RAISE NOTICE 'OK ETAPA B: Secretaría sin acceso directo a la fila de configuración; owner/admin/médico/atenciones/mensajes sin cambios.';
END $$;


-- ---------- QA SQL (pending_review_config_secretaria_v1_tests.sql, secciones 0 a 4; sin su BEGIN ni su cierre) ----------
-- Pruebas SQL de la ETAPA A + B (Bloque 4B): RPC de configuración administrativa + RLS de la fila de configuración
-- SOLO STAGING, con las ETAPAS A y B YA aplicadas. NO ejecutar en Production.
-- Todo corre dentro de UNA transacción que termina en ROLLBACK: la fila de configuración real se reemplaza por una fila SINTÉTICA sólo dentro de la
-- transacción (como postgres) y vuelve a su estado original con el ROLLBACK. No deja datos. No usa datos clínicos reales.
-- Ejecutar en el SQL Editor de STAGING (rol postgres). SIN EJECUTAR: sintaxis sin validar contra una base; ajustar si algún nombre difiere.
--
-- Prerrequisitos: 1 secretaria activa, 1 owner/admin activo y 1 médico activo en cardiolink_user_roles (las cuentas QA de STAGING los cumplen).
-- Estructura: 0) actores y privilegios  1) fixture sintético  2) como SECRETARÍA (RLS directa + RPC)  3) owner/admin  4) médico  5) ROLLBACK.
-- Cualquier falla lanza una excepción (la transacción aborta; el ROLLBACK implícito no deja nada). v3: ninguna prueba se OMITE; si el fixture relacional no se puede crear, el script ABORTA.


-- ===== 0) Actores =====
CREATE TEMP TABLE t_actores AS
SELECT
 (SELECT user_id FROM public.cardiolink_user_roles WHERE base_role='secretaria' AND active ORDER BY user_id LIMIT 1) AS sec,
 (SELECT user_id FROM public.cardiolink_user_roles WHERE base_role IN ('owner','admin') AND active ORDER BY base_role, user_id LIMIT 1) AS own,
 (SELECT user_id FROM public.cardiolink_user_roles WHERE base_role='medico' AND active ORDER BY user_id LIMIT 1) AS med;
GRANT SELECT ON t_actores TO authenticated;
CREATE TEMP TABLE t_hash(k text PRIMARY KEY, h text);
GRANT SELECT ON t_hash TO authenticated;
CREATE TEMP TABLE t_res(nombre text, resultado text);
GRANT ALL ON t_res TO authenticated;

DO $$ DECLARE a record; BEGIN SELECT * INTO a FROM t_actores;
  IF a.sec IS NULL OR a.own IS NULL OR a.med IS NULL THEN RAISE EXCEPTION 'Faltan actores (secretaria, owner/admin, médico activos)'; END IF; END $$;

CREATE OR REPLACE FUNCTION pg_temp.claims(p_uid uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true) $$;

-- Privilegios de ejecución (catálogo)
DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['public.cardiolink_config_administrativa_v1()','public.cardiolink_guardar_config_administrativa_v1(jsonb,text,text,uuid)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN RAISE EXCEPTION 'FALLA: anon puede ejecutar %', f; END IF;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN RAISE EXCEPTION 'FALLA: authenticated no puede ejecutar %', f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.cardiolink_config_claves_lectura_sec_v1()','public.cardiolink_config_claves_escritura_sec_v1()',
                           'public.cardiolink_config_claves_identidad_v1()','public.cardiolink_config_vista_sec_v1(jsonb)',
                           'public.cardiolink_config_fusionar_profesionales_v1(jsonb,jsonb)','public.cardiolink_config_unir_auditoria_v1(jsonb,jsonb)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'FALLA: el helper interno % es ejecutable por anon/authenticated', f; END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones'
                  AND policyname='cardiolink_atenciones_config_solo_admin_v1' AND permissive='RESTRICTIVE') THEN
    RAISE EXCEPTION 'FALLA: falta la política restrictiva (¿ETAPA B aplicada?)'; END IF;
  INSERT INTO t_res VALUES ('00 privilegios y política restrictiva', 'OK');
END $$;

-- ===== 1) Fixture sintético (como postgres). Reemplaza la fila real SÓLO dentro de esta transacción. =====
UPDATE public.cardiolink_atenciones SET payload = jsonb_build_object(
  'tipoRegistro','config','version','T-1','updatedAt','2000-01-01T00:00:00.000Z',
  'config', jsonb_build_object(
    'profesionales', jsonb_build_array(
        jsonb_build_object('id','p1','nombre','Dr Uno','area','A','prestaciones',jsonb_build_array('Consulta'),'valores',jsonb_build_object('consulta',100),
                           'logoDocumentoData','LOGO1','firmaDocumentoData','FIRMA1','matriculaNacional','MN1','campoRaro','RARO1'),
        jsonb_build_object('id','p2','nombre','Dr Dos','area','B')),
    'especialidades', jsonb_build_array('Cardio'),
    'obrasSociales', jsonb_build_array('OS1','OS2'),
    'reglasOS', jsonb_build_object('OS1','R1'),
    'pacientes', jsonb_build_array(
        jsonb_build_object('id','pac1','nombreCompleto','QA UNO','dni','1','notaOculta','CLINICO-P1'),
        jsonb_build_object('id','pac3','nombreCompleto','QA TRES','dni','3')),
    'usuarios', jsonb_build_array(jsonb_build_object('id','u1','usuario','sec','rol','secretaria')),
    'roles', jsonb_build_array(jsonb_build_object('id','secretaria','baseRole','secretaria')),
    'colocadores', jsonb_build_array('X'),
    'conveniosFacturacion', jsonb_build_array(jsonb_build_object('id','c1')),
    'brandingCardioLink', jsonb_build_object('nombre','N'),
    'auditoriaPacientes', jsonb_build_array(jsonb_build_object('id','a1','tipo','fusion_paciente')),
    'migracionesCardioLink', jsonb_build_object('m','1'),
    -- RESTRINGIDAS (nunca deben llegar ni cambiar)
    'evolucionesClinicas', jsonb_build_array(jsonb_build_object('id','e1','pacienteId','pac1','evolucion','CLINICO-E1')),
    'resumenesClinicos', jsonb_build_object('pac1', jsonb_build_object('antecedentes','CLINICO-R1')),
    -- documentos heredados: Secretaría sólo debe LEER los de tipo 'constancia_atencion'; ninguno se escribe nunca
    'documentosClinicos', jsonb_build_array(jsonb_build_object('id','d1','tipo','certificado','pacienteId','pac1','contenido','CLINICO-D1'),
                                            jsonb_build_object('id','d2','tipo','constancia_atencion','pacienteId','pac1','contenido','CONSTANCIA-OK'),
                                            jsonb_build_object('id','d3','tipo','orden','pacienteId','pac1','contenido','CLINICO-D3')),
    'importacionesMedicloudEvoluciones', jsonb_build_array(jsonb_build_object('id','i1')),
    'notasInternasPorProfesional', jsonb_build_object('p1', jsonb_build_object('pac1','CLINICO-N1')),
    'notasInternasMedicas', jsonb_build_object('pac1','CLINICO-N2'),
    'configFinanzas411F', jsonb_build_object('sueldosSecretaria', jsonb_build_array(jsonb_build_object('monto',1))),
    'movimientosFinancieros411C', jsonb_build_array(jsonb_build_object('id','m1')),
    'hcPreparacion', jsonb_build_object('schemaVersion',1),
    'integracionesClinicas', jsonb_build_object('rctaUrl','u'),
    'identidadesArchivadas', jsonb_build_object('p9', jsonb_build_array(jsonb_build_object('identidad', jsonb_build_object('logoDocumentoData','OLD')))),
    'claveDesconocidaFutura', jsonb_build_object('x',1)
  )), updated_at = '2026-01-01T00:00:00Z'::timestamptz
WHERE id = '__cardiolink_config_v1';

-- Fila de atención y mensaje sintéticos para la regresión de acceso
INSERT INTO public.cardiolink_atenciones(id, payload, updated_at) VALUES
 ('__t_att',  jsonb_build_object('id','__t_att','profesionalId',(SELECT professional_id FROM public.cardiolink_user_roles WHERE user_id=(SELECT med FROM t_actores)),'paciente','QA'), now()),
 ('__t_msg',  '{"id":"__t_msg","tipoRegistro":"mensaje","destino":"rol:secretaria","texto":"t","leidoPor":[]}'::jsonb, now());

-- Hashes de TODO lo que Secretaría NO puede escribir (restringidas, desconocidas, usuarios, roles, branding, migraciones y documentosClinicos)
-- antes de cualquier operación de Secretaría: deben quedar idénticas byte a byte.
INSERT INTO t_hash
SELECT e.key, md5(e.value::text)
  FROM public.cardiolink_atenciones a, jsonb_each(a.payload -> 'config') e
 WHERE a.id='__cardiolink_config_v1'
   AND NOT (e.key = ANY (public.cardiolink_config_claves_escritura_sec_v1()));
DO $$ BEGIN
  IF (SELECT count(*) FROM t_hash) < 12 OR NOT EXISTS (SELECT 1 FROM t_hash WHERE k='documentosClinicos') THEN
    RAISE EXCEPTION 'Fixture: faltan hashes de claves no escribibles'; END IF; END $$;

-- ===== 2) COMO SECRETARÍA =====
SET LOCAL ROLE authenticated;

-- 2.1 RLS directa sobre la fila de configuración
DO $$ DECLARE a record; n int; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE id='__cardiolink_config_v1';
  IF n<>0 THEN RAISE EXCEPTION 'FALLA 2.1a: Secretaría VE la fila de configuración (%)', n; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE payload->>'tipoRegistro'='config';
  IF n<>0 THEN RAISE EXCEPTION 'FALLA 2.1b: Secretaría ve filas tipoRegistro=config por otro filtro (%)', n; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE payload ? 'config';
  IF n<>0 THEN RAISE EXCEPTION 'FALLA 2.1c: Secretaría ve filas con payload.config (%)', n; END IF;
  -- API tipo PostgREST: select de columnas parciales del jsonb
  SELECT count(*) INTO n FROM (SELECT payload->'config'->'evolucionesClinicas' FROM public.cardiolink_atenciones WHERE id='__cardiolink_config_v1') s;
  IF n<>0 THEN RAISE EXCEPTION 'FALLA 2.1d: Secretaría extrae evolucionesClinicas por path jsonb'; END IF;
  INSERT INTO t_res VALUES ('2.1 SELECT directo de la fila de config denegado', 'OK');
END $$;

DO $$ DECLARE a record; n int; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload,'{config,evolucionesClinicas}','[]'::jsonb) WHERE id='__cardiolink_config_v1';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n<>0 THEN RAISE EXCEPTION 'FALLA 2.2a: Secretaría actualizó la fila de config (% filas)', n; END IF;
  DELETE FROM public.cardiolink_atenciones WHERE id='__cardiolink_config_v1';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n<>0 THEN RAISE EXCEPTION 'FALLA 2.2b: Secretaría borró la fila de config (% filas)', n; END IF;
  -- upsert ciego como lo hacía el cliente (INSERT … ON CONFLICT DO UPDATE)
  BEGIN
    INSERT INTO public.cardiolink_atenciones(id,payload,updated_at) VALUES ('__cardiolink_config_v1','{"tipoRegistro":"config","config":{}}'::jsonb, now())
      ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload;
    RAISE EXCEPTION 'FALLA 2.2c: el upsert ciego de Secretaría sobre la fila de config NO fue rechazado';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  -- insertar otra fila "config"
  BEGIN
    INSERT INTO public.cardiolink_atenciones(id,payload,updated_at) VALUES ('__t_cfg2','{"tipoRegistro":"config","config":{"x":1}}'::jsonb, now());
    RAISE EXCEPTION 'FALLA 2.2d: Secretaría insertó una fila tipoRegistro=config';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  -- convertir una atención en "config"
  BEGIN
    UPDATE public.cardiolink_atenciones SET payload = payload || '{"tipoRegistro":"config"}'::jsonb WHERE id='__t_att';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n<>0 THEN RAISE EXCEPTION 'FALLA 2.2e: Secretaría convirtió una atención en config'; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;   -- el WITH CHECK rechaza la nueva fila (esperado)
  END;
  INSERT INTO t_res VALUES ('2.2 UPDATE/DELETE/upsert/INSERT de config denegados', 'OK');
END $$;

-- 2.3 Regresión: atenciones y mensajes siguen accesibles; una atención nueva se puede insertar y modificar
DO $$ DECLARE a record; n int; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE id IN ('__t_att','__t_msg');
  IF n<>2 THEN RAISE EXCEPTION 'FALLA 2.3a: Secretaría perdió atenciones/mensajes (%)', n; END IF;
  INSERT INTO public.cardiolink_atenciones(id,payload,updated_at) VALUES ('__t_att_sec','{"id":"__t_att_sec","profesionalId":"x","paciente":"QA"}'::jsonb, now());
  UPDATE public.cardiolink_atenciones SET payload = payload || '{"estado":"confirmado"}'::jsonb WHERE id='__t_att_sec';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'FALLA 2.3b: Secretaría no puede modificar atenciones'; END IF;
  INSERT INTO t_res VALUES ('2.3 atenciones y mensajes siguen funcionando para Secretaría', 'OK');
END $$;

-- 2.4 RPC de lectura: sólo la vista administrativa, con campos anidados filtrados y documentos por tipo
DO $$ DECLARE a record; r jsonb; ks text[]; v jsonb; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  r := public.cardiolink_config_administrativa_v1();
  IF r->>'ok' <> 'true' OR jsonb_typeof(r->'config') <> 'object' THEN RAISE EXCEPTION 'FALLA 2.4a: respuesta inesperada %', left(r::text,200); END IF;
  v := r->'config';
  SELECT array_agg(k ORDER BY k) INTO ks FROM jsonb_object_keys(v) k;
  IF NOT (ks <@ ARRAY['profesionales','especialidades','obrasSociales','reglasOS','pacientes','usuarios','roles','colocadores','medicosDerivantes','motivosConsulta',
        'bloquesPrestaciones','bloquesPrestacionesLabels','horariosProfesionales','arancelesPorProfesional','conveniosPorProfesional','conveniosFacturacion',
        'arancelesConvenios','plantillasPedidos','duracionesPrestacion','catalogoPrestaciones411P','destinosFacturacion','brandingCardioLink','auditoriaPacientes',
        'migracionesCardioLink','documentosClinicos']) THEN
    RAISE EXCEPTION 'FALLA 2.4b: la vista trae claves fuera de la lista de lectura: %', ks; END IF;
  IF r::text ~ 'CLINICO-|sueldosSecretaria|movimientosFinancieros|claveDesconocidaFutura|identidadesArchivadas|rctaUrl|hcPreparacion|RARO1' THEN
    RAISE EXCEPTION 'FALLA 2.4c: la respuesta contiene datos restringidos'; END IF;
  -- documentos: sólo la constancia (tipo permitido); ni el certificado ni la orden
  IF jsonb_array_length(v->'documentosClinicos') <> 1 OR v->'documentosClinicos'->0->>'id' <> 'd2' THEN
    RAISE EXCEPTION 'FALLA 2.4d: la vista de documentos no se limita a los tipos permitidos: %', left((v->'documentosClinicos')::text,200); END IF;
  -- pacientes: campo no administrativo (notaOculta) no se lee; los administrativos sí
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v->'pacientes') p WHERE p ? 'notaOculta') THEN RAISE EXCEPTION 'FALLA 2.4e: la vista expone campos no administrativos del paciente'; END IF;
  IF (SELECT p->>'nombreCompleto' FROM jsonb_array_elements(v->'pacientes') p WHERE p->>'id'='pac1') <> 'QA UNO' THEN RAISE EXCEPTION 'FALLA 2.4f: falta un campo administrativo del paciente'; END IF;
  -- profesionales: campo raro fuera; identidad documental presente (la necesita para imprimir)
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v->'profesionales') p WHERE p ? 'campoRaro') THEN RAISE EXCEPTION 'FALLA 2.4g: la vista expone campos no administrativos del profesional'; END IF;
  IF (SELECT p->>'logoDocumentoData' FROM jsonb_array_elements(v->'profesionales') p WHERE p->>'id'='p1') <> 'LOGO1' THEN RAISE EXCEPTION 'FALLA 2.4h: falta la identidad para imprimir'; END IF;
  IF (r->>'updated_at')::timestamptz <> '2026-01-01T00:00:00Z'::timestamptz THEN RAISE EXCEPTION 'FALLA 2.4i: updated_at incorrecto (%)', r->>'updated_at'; END IF;
  IF length(r->>'vista_hash') <> 32 THEN RAISE EXCEPTION 'FALLA 2.4j: falta vista_hash'; END IF;
  INSERT INTO t_res VALUES ('2.4 RPC de lectura: claves y campos anidados permitidos; documentos por tipo; sin datos restringidos', 'OK');
END $$;

-- 2.5 RPC de escritura: cambio legítimo + payload hostil (claves restringidas, usuarios/roles, identidad, null)
DO $$ DECLARE a record; r jsonb; base jsonb; cfg jsonb; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  base := public.cardiolink_config_administrativa_v1();
  r := public.cardiolink_guardar_config_administrativa_v1(
     jsonb_build_object(
       'obrasSociales', jsonb_build_array('OS1','OS2','OS3'),
       'reglasOS', jsonb_build_object('OS1','R1','OS3','R3'),
       'pacientes', jsonb_build_array(
           jsonb_build_object('id','pac1','nombreCompleto','QA UNO MOD','dni','1','notaOculta','HACK-NOTA','diagnostico','HACK-DX'),
           jsonb_build_object('id','pac2','nombreCompleto','QA DOS','dni','2','notaOculta','HACK-NOTA2'),
           jsonb_build_object('id','pac3','nombreCompleto','QA TRES','dni','3')),
       'profesionales', jsonb_build_array(
           jsonb_build_object('id','p1','nombre','Dr Uno MOD','area','A','prestaciones',jsonb_build_array('Consulta','ECG'),'valores',jsonb_build_object('consulta',150),
                              'campoRaro','HACK-RARO','logoDocumentoData','LOGO-HACKEADO','firmaDocumentoData','','matriculaNacional','MN-HACK','mostrarFirmaDocumento',false),
           jsonb_build_object('id','p2','nombre','Dr Dos','area','B'),
           jsonb_build_object('id','p3','nombre','Dr Nuevo','logoDocumentoData','LOGO-NUEVO','campoRaro','HACK-RARO3')),
       'auditoriaPacientes', jsonb_build_array(jsonb_build_object('id','a2','tipo','fusion_paciente')),
       -- hostiles: NO deben aplicarse
       'evolucionesClinicas', '[]'::jsonb,
       'resumenesClinicos', '{}'::jsonb,
       'documentosClinicos', jsonb_build_array(jsonb_build_object('id','dx','contenido','FORJADO')),
       'notasInternasPorProfesional', '{}'::jsonb,
       'configFinanzas411F', '{}'::jsonb,
       'movimientosFinancieros411C', '[]'::jsonb,
       'identidadesArchivadas', '{}'::jsonb,
       'claveDesconocidaFutura', jsonb_build_object('x',999),
       'usuarios', jsonb_build_array(jsonb_build_object('id','u1','usuario','sec','rol','admin')),
       'roles', '[]'::jsonb,
       'brandingCardioLink', jsonb_build_object('nombre','HACK')),
     base->>'updated_at', base->>'vista_hash', auth.uid());
  IF r->>'ok' <> 'true' THEN RAISE EXCEPTION 'FALLA 2.5a: guardado legítimo rechazado: %', r::text; END IF;
  INSERT INTO t_res VALUES ('2.5a guardado legítimo aceptado', 'OK');
END $$;

-- Verificación como postgres (RLS bypass) del resultado del 2.5
RESET ROLE;
DO $$ DECLARE cfg jsonb; p1 jsonb; p3 jsonb; pa1 jsonb; pa2 jsonb; bad text; BEGIN
  SELECT payload->'config' INTO cfg FROM public.cardiolink_atenciones WHERE id='__cardiolink_config_v1';
  IF jsonb_array_length(cfg->'obrasSociales') <> 3 OR jsonb_array_length(cfg->'pacientes') <> 3 THEN RAISE EXCEPTION 'FALLA 2.5b: el cambio administrativo no se aplicó'; END IF;
  -- TODO lo no escribible (restringidas, desconocidas, usuarios, roles, branding, migraciones, documentosClinicos): idéntico byte a byte
  SELECT string_agg(h.k, ',') INTO bad FROM t_hash h WHERE md5((cfg -> h.k)::text) IS DISTINCT FROM h.h;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'FALLA 2.5c: cambiaron claves no escribibles: %', bad; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(cfg) k WHERE NOT (k = ANY (public.cardiolink_config_claves_escritura_sec_v1()))) <> (SELECT count(*) FROM t_hash) THEN
    RAISE EXCEPTION 'FALLA 2.5d: cambió la cantidad de claves no escribibles'; END IF;
  IF cfg->'usuarios'->0->>'rol' <> 'secretaria' THEN RAISE EXCEPTION 'FALLA 2.5e: Secretaría modificó usuarios'; END IF;
  IF jsonb_array_length(cfg->'roles') <> 1 THEN RAISE EXCEPTION 'FALLA 2.5f: Secretaría modificó roles'; END IF;
  IF cfg->'brandingCardioLink'->>'nombre' <> 'N' THEN RAISE EXCEPTION 'FALLA 2.5g: Secretaría modificó el branding'; END IF;
  IF jsonb_array_length(cfg->'documentosClinicos') <> 3 THEN RAISE EXCEPTION 'FALLA 2.5g2: cambió la cantidad de documentos heredados'; END IF;
  -- profesionales: cambios administrativos sí; identidad y campos no administrativos conservados; el nuevo sin identidad ni campos raros
  SELECT p INTO p1 FROM jsonb_array_elements(cfg->'profesionales') p WHERE p->>'id'='p1';
  IF p1->>'nombre' <> 'Dr Uno MOD' OR (p1->'valores'->>'consulta')::int <> 150 THEN RAISE EXCEPTION 'FALLA 2.5h: no se aplicó el cambio administrativo del profesional'; END IF;
  IF p1->>'logoDocumentoData' <> 'LOGO1' OR p1->>'firmaDocumentoData' <> 'FIRMA1' OR p1->>'matriculaNacional' <> 'MN1' THEN
    RAISE EXCEPTION 'FALLA 2.5i: se pisó la identidad documental del profesional'; END IF;
  IF p1 ? 'mostrarFirmaDocumento' THEN RAISE EXCEPTION 'FALLA 2.5i2: se agregó/modificó mostrarFirmaDocumento (identidad)'; END IF;
  IF p1->>'campoRaro' <> 'RARO1' THEN RAISE EXCEPTION 'FALLA 2.5i3: se pisó un campo no administrativo del profesional'; END IF;
  SELECT p INTO p3 FROM jsonb_array_elements(cfg->'profesionales') p WHERE p->>'id'='p3';
  IF p3 IS NULL OR p3 ? 'logoDocumentoData' OR p3 ? 'campoRaro' THEN RAISE EXCEPTION 'FALLA 2.5j: profesional nuevo ausente o con identidad/campos no permitidos'; END IF;
  -- pacientes: administrativos sí; no administrativos conservados (existente) o ausentes (nuevo)
  SELECT p INTO pa1 FROM jsonb_array_elements(cfg->'pacientes') p WHERE p->>'id'='pac1';
  IF pa1->>'nombreCompleto' <> 'QA UNO MOD' THEN RAISE EXCEPTION 'FALLA 2.5j2: no se aplicó el cambio administrativo del paciente'; END IF;
  IF pa1->>'notaOculta' <> 'CLINICO-P1' OR pa1 ? 'diagnostico' THEN RAISE EXCEPTION 'FALLA 2.5j3: se pisó/agregó un campo no administrativo de un paciente existente'; END IF;
  SELECT p INTO pa2 FROM jsonb_array_elements(cfg->'pacientes') p WHERE p->>'id'='pac2';
  IF pa2 IS NULL OR pa2 ? 'notaOculta' OR pa2->>'nombreCompleto' <> 'QA DOS' THEN RAISE EXCEPTION 'FALLA 2.5j4: paciente nuevo ausente o con campos no administrativos'; END IF;
  -- auditoría: sólo se agrega
  IF jsonb_array_length(cfg->'auditoriaPacientes') <> 2 OR cfg->'auditoriaPacientes'->0->>'id' <> 'a1' THEN RAISE EXCEPTION 'FALLA 2.5k: auditoriaPacientes no es una unión'; END IF;
  -- payload: version/tipoRegistro conservados, updatedAt y updated_at avanzaron
  IF (SELECT payload->>'version' FROM public.cardiolink_atenciones WHERE id='__cardiolink_config_v1') <> 'T-1'
     OR (SELECT payload->>'tipoRegistro' FROM public.cardiolink_atenciones WHERE id='__cardiolink_config_v1') <> 'config' THEN
    RAISE EXCEPTION 'FALLA 2.5l: se alteró version/tipoRegistro'; END IF;
  IF (SELECT updated_at FROM public.cardiolink_atenciones WHERE id='__cardiolink_config_v1') <= '2026-01-01T00:00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'FALLA 2.5m: updated_at no avanzó'; END IF;
  INSERT INTO t_res VALUES ('2.5 escritura: sólo claves y campos permitidos; no escribible intacto (incl. documentos heredados); identidad preservada', 'OK');
END $$;

SET LOCAL ROLE authenticated;

-- 2.6 Concurrencia
DO $$ DECLARE a record; r0 jsonb; r1 jsonb; r2 jsonb; r3 jsonb; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  r0 := public.cardiolink_config_administrativa_v1();
  -- (a) un escritor concurrente (dueño/otro) cambia el contenido administrativo
  RESET ROLE;
  UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload,'{config,colocadores}','["X","Y"]'::jsonb), updated_at = clock_timestamp() WHERE id='__cardiolink_config_v1';
  SET LOCAL ROLE authenticated; PERFORM pg_temp.claims(a.sec);
  r1 := public.cardiolink_guardar_config_administrativa_v1('{"colocadores":["Z"]}'::jsonb, r0->>'updated_at', r0->>'vista_hash', auth.uid());
  IF r1->>'conflict' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'FALLA 2.6a: no hubo conflicto con base vieja y contenido distinto: %', r1::text; END IF;
  RESET ROLE;
  IF (SELECT payload#>'{config,colocadores}' FROM public.cardiolink_atenciones WHERE id='__cardiolink_config_v1') <> '["X","Y"]'::jsonb THEN
    RAISE EXCEPTION 'FALLA 2.6b: el conflicto escribió igual'; END IF;
  SET LOCAL ROLE authenticated; PERFORM pg_temp.claims(a.sec);
  -- (b) tras releer, el guardado pasa
  r2 := public.cardiolink_config_administrativa_v1();
  r3 := public.cardiolink_guardar_config_administrativa_v1('{"colocadores":["Z"]}'::jsonb, r2->>'updated_at', r2->>'vista_hash', auth.uid());
  IF r3->>'ok' <> 'true' THEN RAISE EXCEPTION 'FALLA 2.6c: guardado con base vigente rechazado: %', r3::text; END IF;
  -- (c) la fila cambió sólo por una escritura clínica ajena (el hash de lo escribible es igual) → NO es conflicto
  RESET ROLE;
  UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload,'{config,notasInternasMedicas}','{"pac1":"CLINICO-N2-OTRA-ESCRITURA"}'::jsonb), updated_at = clock_timestamp() WHERE id='__cardiolink_config_v1';
  -- este cambio lo hace "otro escritor" (dueño): se actualiza la huella de referencia de esa clave restringida
  UPDATE t_hash SET h = md5((SELECT (payload->'config'->'notasInternasMedicas')::text FROM public.cardiolink_atenciones WHERE id='__cardiolink_config_v1')) WHERE k='notasInternasMedicas';
  SET LOCAL ROLE authenticated; PERFORM pg_temp.claims(a.sec);
  r1 := public.cardiolink_guardar_config_administrativa_v1('{"colocadores":["W"]}'::jsonb, r3->>'updated_at', r3->>'vista_hash', auth.uid());
  IF r1->>'ok' <> 'true' THEN RAISE EXCEPTION 'FALLA 2.6d: conflicto falso por una escritura clínica ajena: %', r1::text; END IF;
  INSERT INTO t_res VALUES ('2.6 concurrencia: conflicto real detectado sin escribir; sin falsos conflictos por escrituras clínicas', 'OK');
END $$;

-- 2.7 Validaciones de entrada (cada una debe fallar y no cambiar nada)
DO $$ DECLARE a record; r jsonb; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  r := public.cardiolink_config_administrativa_v1();
  -- sin versión base
  BEGIN PERFORM public.cardiolink_guardar_config_administrativa_v1('{"colocadores":["A"]}'::jsonb, NULL, r->>'vista_hash', auth.uid());
        RAISE EXCEPTION 'FALLA 2.7a: aceptó base nula'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.cardiolink_guardar_config_administrativa_v1('{"colocadores":["A"]}'::jsonb, 'no-es-fecha', r->>'vista_hash', auth.uid());
        RAISE EXCEPTION 'FALLA 2.7b: aceptó base inválida'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  -- null / tipo distinto / vaciado accidental / elementos sin id
  BEGIN PERFORM public.cardiolink_guardar_config_administrativa_v1('{"colocadores":null}'::jsonb, r->>'updated_at', r->>'vista_hash', auth.uid());
        RAISE EXCEPTION 'FALLA 2.7c: aceptó null'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.cardiolink_guardar_config_administrativa_v1('{"colocadores":{"a":1}}'::jsonb, r->>'updated_at', r->>'vista_hash', auth.uid());
        RAISE EXCEPTION 'FALLA 2.7d: aceptó cambio de tipo'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.cardiolink_guardar_config_administrativa_v1('{"pacientes":[]}'::jsonb, r->>'updated_at', r->>'vista_hash', auth.uid());
        RAISE EXCEPTION 'FALLA 2.7e: aceptó vaciar pacientes'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.cardiolink_guardar_config_administrativa_v1('{"profesionales":[{"nombre":"sin id"}]}'::jsonb, r->>'updated_at', r->>'vista_hash', auth.uid());
        RAISE EXCEPTION 'FALLA 2.7f: aceptó profesional sin id'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  -- quitar un profesional CON identidad (p1) → denegado; sin identidad (p2) → permitido
  BEGIN PERFORM public.cardiolink_guardar_config_administrativa_v1('{"profesionales":[{"id":"p2","nombre":"Dr Dos"},{"id":"p3","nombre":"Dr Nuevo"}]}'::jsonb, r->>'updated_at', r->>'vista_hash', auth.uid());
        RAISE EXCEPTION 'FALLA 2.7g: aceptó quitar un profesional con identidad'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  r := public.cardiolink_guardar_config_administrativa_v1('{"profesionales":[{"id":"p1","nombre":"Dr Uno MOD"},{"id":"p3","nombre":"Dr Nuevo"}]}'::jsonb, r->>'updated_at', r->>'vista_hash', auth.uid());
  IF r->>'ok' <> 'true' THEN RAISE EXCEPTION 'FALLA 2.7h: no se pudo quitar un profesional sin identidad: %', r::text; END IF;
  INSERT INTO t_res VALUES ('2.7 validaciones de entrada (null, tipo, vaciado, sin id, base, identidad)', 'OK');
END $$;

-- 2.8 Pacientes: bajas con historia clínica asociada, ids duplicados y elementos inválidos
DO $$ DECLARE a record; r jsonb; pacs jsonb; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  r := public.cardiolink_config_administrativa_v1();
  pacs := r->'config'->'pacientes';
  -- (a) quitar pac1: tiene evolución, resumen y documentos heredados → denegado (42501)
  BEGIN PERFORM public.cardiolink_guardar_config_administrativa_v1(
          jsonb_build_object('pacientes', (SELECT jsonb_agg(p) FROM jsonb_array_elements(pacs) p WHERE p->>'id' <> 'pac1')), r->>'updated_at', r->>'vista_hash', auth.uid());
        RAISE EXCEPTION 'FALLA 2.8a: aceptó quitar un paciente con historia clínica heredada';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  -- (b) ids duplicados → 22023
  BEGIN PERFORM public.cardiolink_guardar_config_administrativa_v1(jsonb_build_object('pacientes', pacs || pacs), r->>'updated_at', r->>'vista_hash', auth.uid());
        RAISE EXCEPTION 'FALLA 2.8b: aceptó ids duplicados';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  -- (c) elemento sin id / no objeto → 22023
  BEGIN PERFORM public.cardiolink_guardar_config_administrativa_v1(jsonb_build_object('pacientes', pacs || '[{"nombreCompleto":"sin id"}]'::jsonb), r->>'updated_at', r->>'vista_hash', auth.uid());
        RAISE EXCEPTION 'FALLA 2.8c: aceptó un paciente sin id';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.cardiolink_guardar_config_administrativa_v1(jsonb_build_object('pacientes', pacs || '["texto"]'::jsonb), r->>'updated_at', r->>'vista_hash', auth.uid());
        RAISE EXCEPTION 'FALLA 2.8c2: aceptó un elemento que no es objeto';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  -- (d) quitar pac3 (sin historia clínica) → permitido
  r := public.cardiolink_guardar_config_administrativa_v1(
          jsonb_build_object('pacientes', (SELECT jsonb_agg(p) FROM jsonb_array_elements(pacs) p WHERE p->>'id' <> 'pac3')), r->>'updated_at', r->>'vista_hash', auth.uid());
  IF r->>'ok' <> 'true' THEN RAISE EXCEPTION 'FALLA 2.8d: no se pudo quitar un paciente sin historia clínica: %', r::text; END IF;
  INSERT INTO t_res VALUES ('2.8 pacientes: baja con historia clínica denegada; duplicados/ids inválidos rechazados; baja sin historia permitida', 'OK');
END $$;

-- 2.8e FIXTURE RELACIONAL SINTÉTICO (v3). Como postgres, DENTRO de esta transacción: se deshace por completo con el ROLLBACK final. NO se omite nunca:
-- si el esquema no permite crear el fixture, el script ABORTA con una excepción (no existe una rama de omisión que pueda confundirse con un PASS).
-- Tres pacientes sintéticos (ids qa_rel_*): uno con una evolución en cardiolink_hc_evoluciones, uno con un resumen en cardiolink_hc_resumen y uno sin historia.
RESET ROLE;
DO $$
DECLARE
  ids  text[] := ARRAY['qa_rel_evo','qa_rel_res','qa_rel_sin'];
  i    text; c record; cols text; vals text; v text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.cardiolink_pacientes WHERE id = ANY (ids))
     OR EXISTS (SELECT 1 FROM public.cardiolink_hc_evoluciones WHERE paciente_id = ANY (ids))
     OR EXISTS (SELECT 1 FROM public.cardiolink_hc_resumen WHERE paciente_id = ANY (ids)) THEN
    RAISE EXCEPTION 'Fixture 2.8e: ya existen filas qa_rel_* en las tablas relacionales; se aborta sin tocar nada';
  END IF;
  FOREACH i IN ARRAY ids LOOP
    cols := 'id'; vals := quote_literal(i);
    -- sólo las columnas NOT NULL sin valor por defecto (además del id), con valores sintéticos según su tipo
    FOR c IN SELECT column_name, data_type FROM information_schema.columns
              WHERE table_schema='public' AND table_name='cardiolink_pacientes' AND is_nullable='NO' AND column_default IS NULL AND column_name <> 'id'
              ORDER BY ordinal_position LOOP
      cols := cols || ',' || quote_ident(c.column_name);
      IF c.data_type IN ('text','character varying','character') THEN v := quote_literal('QA SINTETICO ' || i);
      ELSIF c.data_type LIKE 'timestamp%' THEN v := 'now()';
      ELSIF c.data_type = 'date' THEN v := 'current_date';
      ELSIF c.data_type = 'boolean' THEN v := 'false';
      ELSIF c.data_type IN ('integer','bigint','smallint','numeric') THEN v := '0';
      ELSIF c.data_type = 'uuid' THEN v := 'gen_random_uuid()';
      ELSIF c.data_type IN ('jsonb','json') THEN v := quote_literal('{}') || '::' || c.data_type;
      ELSE RAISE EXCEPTION 'Fixture 2.8e: columna obligatoria % de tipo % sin valor sintético definido (completar a mano y reintentar)', c.column_name, c.data_type;
      END IF;
      vals := vals || ',' || v;
    END LOOP;
    EXECUTE format('INSERT INTO public.cardiolink_pacientes(%s) VALUES (%s)', cols, vals);
  END LOOP;
  INSERT INTO public.cardiolink_hc_evoluciones(id, paciente_id) VALUES ('qa_rel_evo_e1', 'qa_rel_evo');
  INSERT INTO public.cardiolink_hc_resumen(paciente_id) VALUES ('qa_rel_res');
  -- los tres pacientes también existen en la configuración heredada (sin ninguna referencia clínica heredada)
  UPDATE public.cardiolink_atenciones
     SET payload = jsonb_set(payload, '{config,pacientes}',
           (payload #> '{config,pacientes}') || jsonb_build_array(
              jsonb_build_object('id','qa_rel_evo','nombreCompleto','QA REL EVO'),
              jsonb_build_object('id','qa_rel_res','nombreCompleto','QA REL RES'),
              jsonb_build_object('id','qa_rel_sin','nombreCompleto','QA REL SIN')))
   WHERE id = '__cardiolink_config_v1';          -- updated_at NO se toca: la versión base de Secretaría sigue vigente
  -- el fixture existe de verdad (si no, esta prueba no prueba nada)
  IF (SELECT count(*) FROM public.cardiolink_pacientes WHERE id = ANY (ids)) <> 3
     OR (SELECT count(*) FROM public.cardiolink_hc_evoluciones WHERE paciente_id = 'qa_rel_evo') <> 1
     OR (SELECT count(*) FROM public.cardiolink_hc_resumen WHERE paciente_id = 'qa_rel_res') <> 1 THEN
    RAISE EXCEPTION 'Fixture 2.8e: no quedó creado el fixture relacional'; END IF;
  -- el helper reconoce cada caso (como postgres; no es ejecutable por authenticated)
  IF NOT public.cardiolink_config_paciente_con_clinica_v1((SELECT payload->'config' FROM public.cardiolink_atenciones WHERE id='__cardiolink_config_v1'), 'qa_rel_evo')
     OR NOT public.cardiolink_config_paciente_con_clinica_v1((SELECT payload->'config' FROM public.cardiolink_atenciones WHERE id='__cardiolink_config_v1'), 'qa_rel_res')
     OR public.cardiolink_config_paciente_con_clinica_v1((SELECT payload->'config' FROM public.cardiolink_atenciones WHERE id='__cardiolink_config_v1'), 'qa_rel_sin') THEN
    RAISE EXCEPTION 'FALLA 2.8e0: el helper no distingue pacientes con/sin historia clínica relacional'; END IF;
  INSERT INTO t_res VALUES ('2.8e0 fixture relacional creado; el helper distingue evolución / resumen / sin historia', 'OK');
END $$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE a record; r jsonb; pacs jsonb; m text;
BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  r := public.cardiolink_config_administrativa_v1(); pacs := r->'config'->'pacientes';
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(pacs) p WHERE p->>'id' = 'qa_rel_evo') THEN RAISE EXCEPTION 'FALLA 2.8e1: Secretaría no ve el paciente del fixture'; END IF;
  -- (1) quitar el paciente con evolución relacional → 42501 por historia clínica (no por otra causa)
  BEGIN
    PERFORM public.cardiolink_guardar_config_administrativa_v1(
      jsonb_build_object('pacientes', (SELECT jsonb_agg(p) FROM jsonb_array_elements(pacs) p WHERE p->>'id' <> 'qa_rel_evo')), r->>'updated_at', r->>'vista_hash', a.sec);
    RAISE EXCEPTION 'FALLA 2.8e2: aceptó quitar un paciente con evolución en cardiolink_hc_evoluciones';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS m = MESSAGE_TEXT;
    IF m NOT LIKE '%historia clínica asociada%' THEN RAISE EXCEPTION 'FALLA 2.8e2: se rechazó por otra causa: %', m; END IF;
  END;
  -- (2) quitar el paciente con resumen relacional → 42501 por historia clínica
  BEGIN
    PERFORM public.cardiolink_guardar_config_administrativa_v1(
      jsonb_build_object('pacientes', (SELECT jsonb_agg(p) FROM jsonb_array_elements(pacs) p WHERE p->>'id' <> 'qa_rel_res')), r->>'updated_at', r->>'vista_hash', a.sec);
    RAISE EXCEPTION 'FALLA 2.8e3: aceptó quitar un paciente con resumen en cardiolink_hc_resumen';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS m = MESSAGE_TEXT;
    IF m NOT LIKE '%historia clínica asociada%' THEN RAISE EXCEPTION 'FALLA 2.8e3: se rechazó por otra causa: %', m; END IF;
  END;
  -- (3) control negativo: quitar el paciente SIN historia → permitido (el bloqueo anterior no es un rechazo genérico)
  r := public.cardiolink_guardar_config_administrativa_v1(
      jsonb_build_object('pacientes', (SELECT jsonb_agg(p) FROM jsonb_array_elements(pacs) p WHERE p->>'id' <> 'qa_rel_sin')), r->>'updated_at', r->>'vista_hash', a.sec);
  IF r->>'ok' <> 'true' THEN RAISE EXCEPTION 'FALLA 2.8e4: no se pudo quitar un paciente sin historia relacional: %', r::text; END IF;
  -- (4) tras los rechazos, los dos pacientes con historia siguen en la configuración
  r := public.cardiolink_config_administrativa_v1();
  IF (SELECT count(*) FROM jsonb_array_elements(r->'config'->'pacientes') p WHERE p->>'id' IN ('qa_rel_evo','qa_rel_res')) <> 2
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(r->'config'->'pacientes') p WHERE p->>'id' = 'qa_rel_sin') THEN
    RAISE EXCEPTION 'FALLA 2.8e5: el estado de pacientes tras los rechazos no es el esperado'; END IF;
  INSERT INTO t_res VALUES ('2.8e baja bloqueada por historia clínica RELACIONAL (evolución y resumen), con fixture real; sin historia sí se puede', 'OK');
END $$;

-- 2.8f Control positivo: sin las filas relacionales, la misma baja SÍ se permite (demuestra que lo que bloqueaba era la historia relacional).
RESET ROLE;
DELETE FROM public.cardiolink_hc_evoluciones WHERE id = 'qa_rel_evo_e1' AND paciente_id = 'qa_rel_evo';   -- fila SINTÉTICA de este fixture (se revierte con el ROLLBACK)
SET LOCAL ROLE authenticated;
DO $$
DECLARE a record; r jsonb; pacs jsonb;
BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  r := public.cardiolink_config_administrativa_v1(); pacs := r->'config'->'pacientes';
  r := public.cardiolink_guardar_config_administrativa_v1(
      jsonb_build_object('pacientes', (SELECT jsonb_agg(p) FROM jsonb_array_elements(pacs) p WHERE p->>'id' <> 'qa_rel_evo')), r->>'updated_at', r->>'vista_hash', a.sec);
  IF r->>'ok' <> 'true' THEN RAISE EXCEPTION 'FALLA 2.8f: sin la evolución relacional la baja debía permitirse: %', r::text; END IF;
  INSERT INTO t_res VALUES ('2.8f control positivo: sin filas relacionales la baja se permite', 'OK');
END $$;

-- 2.9 Tras todas las operaciones de Secretaría: documentos heredados y TODO lo no escribible, intactos
RESET ROLE;
DO $$ DECLARE cfg jsonb; bad text; BEGIN
  SELECT payload->'config' INTO cfg FROM public.cardiolink_atenciones WHERE id='__cardiolink_config_v1';
  SELECT string_agg(h.k, ',') INTO bad FROM t_hash h WHERE md5((cfg -> h.k)::text) IS DISTINCT FROM h.h;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'FALLA 2.9a: cambiaron claves no escribibles tras la secuencia completa: %', bad; END IF;
  IF jsonb_array_length(cfg->'documentosClinicos') <> 3
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(cfg->'documentosClinicos') d WHERE d->>'contenido' = 'CLINICO-D1')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(cfg->'documentosClinicos') d WHERE d->>'contenido' = 'CLINICO-D3') THEN
    RAISE EXCEPTION 'FALLA 2.9b: se alteraron los documentos heredados'; END IF;
  IF cfg->'evolucionesClinicas'->0->>'evolucion' <> 'CLINICO-E1' THEN RAISE EXCEPTION 'FALLA 2.9c: se alteró la evolución heredada'; END IF;
  INSERT INTO t_res VALUES ('2.9 documentos heredados y datos clínicos intactos tras toda la secuencia de Secretaría', 'OK');
END $$;
SET LOCAL ROLE authenticated;

-- 2.10 CAMBIO DE SESIÓN (v3): una operación iniciada por un usuario nunca se ejecuta con las credenciales de otro. p_uid_esperado = usuario que inició el guardado.
DO $$
DECLARE a record; r jsonb; r2 jsonb; h text; n int;
BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  r := public.cardiolink_config_administrativa_v1();
  -- (a) el token es de Secretaría pero la operación la inició OTRO usuario (owner) → 42501 SESION_DISTINTA, sin escribir
  BEGIN
    PERFORM public.cardiolink_guardar_config_administrativa_v1('{"colocadores":["SESION-A"]}'::jsonb, r->>'updated_at', r->>'vista_hash', a.own);
    RAISE EXCEPTION 'FALLA 2.10a: aceptó una operación iniciada por otro usuario';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
    IF h IS DISTINCT FROM 'SESION_DISTINTA' THEN RAISE EXCEPTION 'FALLA 2.10a: se rechazó sin el HINT SESION_DISTINTA (%)', h; END IF;
  END;
  -- (b) sin uid_esperado válido del mismo usuario (uuid inexistente) → también rechazado
  BEGIN
    PERFORM public.cardiolink_guardar_config_administrativa_v1('{"colocadores":["SESION-B"]}'::jsonb, r->>'updated_at', r->>'vista_hash', '00000000-0000-0000-0000-000000000000'::uuid);
    RAISE EXCEPTION 'FALLA 2.10b: aceptó un uid esperado inexistente';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  -- (c) nada se escribió
  r2 := public.cardiolink_config_administrativa_v1();
  IF r2::text LIKE '%SESION-A%' OR r2::text LIKE '%SESION-B%' OR r2->>'updated_at' IS DISTINCT FROM r->>'updated_at' THEN
    RAISE EXCEPTION 'FALLA 2.10c: una operación de sesión distinta modificó la configuración'; END IF;
  -- (d) la operación inversa: el token es de OTRO usuario (owner) y la operación la inició Secretaría → rechazada por la sesión antes que por el rol
  PERFORM pg_temp.claims(a.own);
  BEGIN
    PERFORM public.cardiolink_guardar_config_administrativa_v1('{"colocadores":["SESION-C"]}'::jsonb, r->>'updated_at', r->>'vista_hash', a.sec);
    RAISE EXCEPTION 'FALLA 2.10d: aceptó la operación de Secretaría con el token de otro usuario';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
    IF h IS DISTINCT FROM 'SESION_DISTINTA' THEN RAISE EXCEPTION 'FALLA 2.10d: no se rechazó por la sesión (hint %)', h; END IF;
  END;
  -- (e) control positivo: mismo usuario → se guarda
  PERFORM pg_temp.claims(a.sec);
  r2 := public.cardiolink_guardar_config_administrativa_v1('{"colocadores":["SESION-OK"]}'::jsonb, r->>'updated_at', r->>'vista_hash', a.sec);
  IF r2->>'ok' <> 'true' THEN RAISE EXCEPTION 'FALLA 2.10e: el guardado de la misma sesión debía funcionar: %', r2::text; END IF;
  INSERT INTO t_res VALUES ('2.10 cambio de sesión: operación de otro usuario rechazada (SESION_DISTINTA) en ambos sentidos; misma sesión guarda', 'OK');
END $$;

-- 2.11 p_uid_esperado OBLIGATORIO (v3.1): sin DEFAULT; omitido, NULL o de otro usuario → rechazado y sin escribir nada.
DO $$
DECLARE a record; r jsonb; r2 jsonb; h text; n_args int; n_def int; n_firmas int;
BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  -- (a) catálogo: una única firma, 4 argumentos, ninguno con valor por defecto
  SELECT count(*), max(pronargs), max(pronargdefaults) INTO n_firmas, n_args, n_def FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'cardiolink_guardar_config_administrativa_v1';
  IF n_firmas <> 1 OR n_args <> 4 OR n_def <> 0 THEN
    RAISE EXCEPTION 'FALLA 2.11a: la RPC debe tener una única firma de 4 argumentos sin valores por defecto (firmas=%, args=%, defaults=%)', n_firmas, n_args, n_def; END IF;
  r := public.cardiolink_config_administrativa_v1();
  -- (b) parámetro OMITIDO (llamada de 3 argumentos): la función no existe para esa llamada
  BEGIN
    PERFORM public.cardiolink_guardar_config_administrativa_v1('{"colocadores":["OMITIDO"]}'::jsonb, r->>'updated_at', r->>'vista_hash');
    RAISE EXCEPTION 'FALLA 2.11b: aceptó una llamada sin p_uid_esperado';
  EXCEPTION WHEN undefined_function THEN NULL; END;
  -- (c) NULL explícito: rechazo explícito 22023 con su HINT (también con el token de otro rol: se evalúa antes que los permisos)
  BEGIN
    PERFORM public.cardiolink_guardar_config_administrativa_v1('{"colocadores":["NULO"]}'::jsonb, r->>'updated_at', r->>'vista_hash', NULL::uuid);
    RAISE EXCEPTION 'FALLA 2.11c: aceptó p_uid_esperado NULL';
  EXCEPTION WHEN invalid_parameter_value THEN
    GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
    IF h IS DISTINCT FROM 'UID_ESPERADO_OBLIGATORIO' THEN RAISE EXCEPTION 'FALLA 2.11c: se rechazó sin el HINT esperado (%)', h; END IF;
  END;
  -- (d) UUID ajeno (aleatorio, inexistente) y UUID de otro usuario real: 42501 SESION_DISTINTA
  BEGIN
    PERFORM public.cardiolink_guardar_config_administrativa_v1('{"colocadores":["AJENO"]}'::jsonb, r->>'updated_at', r->>'vista_hash', gen_random_uuid());
    RAISE EXCEPTION 'FALLA 2.11d: aceptó un UUID ajeno';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
    IF h IS DISTINCT FROM 'SESION_DISTINTA' THEN RAISE EXCEPTION 'FALLA 2.11d: hint inesperado (%)', h; END IF;
  END;
  BEGIN
    PERFORM public.cardiolink_guardar_config_administrativa_v1('{"colocadores":["AJENO2"]}'::jsonb, r->>'updated_at', r->>'vista_hash', a.med);
    RAISE EXCEPTION 'FALLA 2.11d2: aceptó el UUID de otro usuario';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  -- (e) sin sesión (auth.uid() NULL) con un UUID cualquiera: rechazado
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.cardiolink_guardar_config_administrativa_v1('{"colocadores":["ANON"]}'::jsonb, r->>'updated_at', r->>'vista_hash', a.sec);
    RAISE EXCEPTION 'FALLA 2.11e: aceptó una llamada sin sesión';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  -- (f) nada se escribió
  PERFORM pg_temp.claims(a.sec);
  r2 := public.cardiolink_config_administrativa_v1();
  IF r2::text ~ '(OMITIDO|NULO|AJENO|ANON)' OR r2->>'updated_at' IS DISTINCT FROM r->>'updated_at' THEN
    RAISE EXCEPTION 'FALLA 2.11f: una llamada con p_uid_esperado omitido/NULL/ajeno modificó la configuración'; END IF;
  INSERT INTO t_res VALUES ('2.11 p_uid_esperado obligatorio: omitido (42883), NULL (22023), UUID ajeno/otro usuario/sin sesión (42501); nada se escribe', 'OK');
END $$;

-- ===== 3) OWNER/ADMIN: sin regresión (lectura y escritura directas de la fila completa) =====
DO $$ DECLARE a record; n int; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.own);
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE id='__cardiolink_config_v1' AND payload#>'{config,evolucionesClinicas}' IS NOT NULL;
  IF n<>1 THEN RAISE EXCEPTION 'FALLA 3.1: owner/admin no ve la fila completa'; END IF;
  UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload,'{config,especialidades}','["Cardio","Otra"]'::jsonb), updated_at = now() WHERE id='__cardiolink_config_v1';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'FALLA 3.2: owner/admin no puede escribir la fila completa'; END IF;
  INSERT INTO public.cardiolink_atenciones(id,payload,updated_at) VALUES ('__cardiolink_config_v1','{"tipoRegistro":"config","config":{"especialidades":["Cardio","Otra"]}}'::jsonb, now())
    ON CONFLICT (id) DO UPDATE SET payload = jsonb_set(public.cardiolink_atenciones.payload,'{config,especialidades}','["Cardio","Otra","Mas"]'::jsonb);
  BEGIN PERFORM public.cardiolink_config_administrativa_v1(); RAISE EXCEPTION 'FALLA 3.3a: owner/admin puede usar la RPC de Secretaría';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.cardiolink_guardar_config_administrativa_v1('{}'::jsonb,'2026-01-01T00:00:00Z','x', auth.uid()); RAISE EXCEPTION 'FALLA 3.3b: owner/admin puede guardar por la RPC de Secretaría';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  INSERT INTO t_res VALUES ('3 owner/admin: acceso directo intacto; sin acceso a las RPC de Secretaría', 'OK');
END $$;

-- ===== 4) MÉDICO: sigue sin acceso a la fila; RPC denegadas =====
DO $$ DECLARE a record; n int; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.med);
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE id='__cardiolink_config_v1';
  IF n<>0 THEN RAISE EXCEPTION 'FALLA 4.1: el médico ve la fila de config'; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE id='__t_att';
  IF n<>1 THEN RAISE EXCEPTION 'FALLA 4.2: el médico no ve su atención'; END IF;
  BEGIN PERFORM public.cardiolink_config_administrativa_v1(); RAISE EXCEPTION 'FALLA 4.3a: el médico puede usar la RPC de lectura';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.cardiolink_guardar_config_administrativa_v1('{}'::jsonb,'2026-01-01T00:00:00Z','x', auth.uid()); RAISE EXCEPTION 'FALLA 4.3b: el médico puede usar la RPC de escritura';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  INSERT INTO t_res VALUES ('4 médico: sin acceso a la fila ni a las RPC; sus atenciones siguen visibles', 'OK');
END $$;


-- ---------- FIN DEL QA: resultados (visibles si el cliente muestra todos los resultados) y se REVIERTE TODO ----------
RESET ROLE;
SELECT nombre, resultado FROM t_res ORDER BY nombre;      -- se esperan 18 filas, todas 'OK'
ROLLBACK;

-- ===== VERIFICACION POSTERIOR (una sola fila; debe decir 'ENSAYO OK') =====
-- Valores absolutos, sin depender de nada creado antes de la transaccion.
WITH v AS (
  SELECT
    (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
       'cardiolink_config_administrativa_v1','cardiolink_guardar_config_administrativa_v1','cardiolink_config_claves_lectura_sec_v1',
       'cardiolink_config_claves_escritura_sec_v1','cardiolink_config_claves_identidad_v1','cardiolink_config_campos_paciente_v1',
       'cardiolink_config_campos_profesional_admin_v1','cardiolink_config_tipos_doc_sec_v1','cardiolink_config_filtrar_objetos_v1',
       'cardiolink_config_vista_sec_v1','cardiolink_config_vista_escritura_sec_v1','cardiolink_config_paciente_con_clinica_v1',
       'cardiolink_config_fusionar_pacientes_v1','cardiolink_config_fusionar_profesionales_v1','cardiolink_config_unir_auditoria_v1')) AS funciones_del_bloque_restantes,
    (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones'
        AND policyname='cardiolink_atenciones_config_solo_admin_v1') AS politica_restrictiva_restante,
    (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones'
        AND (coalesce(qual,'') ~ 'cardiolink_atencion_permitida_v2' OR coalesce(with_check,'') ~ 'cardiolink_atencion_permitida_v2')) AS politicas_con_predicado_v2,
    (SELECT regexp_replace(prosrc, '\s+', '', 'g') = regexp_replace($ens$
 SELECT CASE
   WHEN p_rol IN ('owner','admin','secretaria') THEN true
   WHEN p_rol = 'medico' THEN nullif(pg_catalog.btrim(p_prof),'') IS NOT NULL
        AND p_prof = p_payload->>'profesionalId'
        AND coalesce(p_payload->>'tipoRegistro','') NOT IN ('mensaje','config')
   ELSE false END
$ens$, '\s+', '', 'g')
       FROM pg_proc WHERE oid = 'public.cardiolink_atencion_permitida_v2(jsonb,text,text)'::regprocedure) AS predicado_igual_al_previo,
    (SELECT count(*) FROM public.cardiolink_atenciones WHERE id = '__cardiolink_config_v1'
        AND payload ->> 'version' IS DISTINCT FROM 'T-1'
        AND payload ->> 'updatedAt' IS DISTINCT FROM '2000-01-01T00:00:00.000Z'
        AND updated_at IS DISTINCT FROM '2026-01-01T00:00:00Z'::timestamptz
        AND NOT ((payload -> 'config') ? 'claveDesconocidaFutura')) AS fila_config_sin_marcas_del_fixture,
    (SELECT count(*) FROM public.cardiolink_atenciones WHERE id LIKE E'\\_\\_t\\_%') AS atenciones_sinteticas_restantes,
    (SELECT count(*) FROM public.cardiolink_pacientes WHERE id LIKE E'qa\\_rel\\_%') AS pacientes_sinteticos_restantes,
    (SELECT count(*) FROM public.cardiolink_hc_evoluciones WHERE paciente_id LIKE E'qa\\_rel\\_%') AS evoluciones_sinteticas_restantes,
    (SELECT count(*) FROM public.cardiolink_hc_resumen WHERE paciente_id LIKE E'qa\\_rel\\_%') AS resumenes_sinteticos_restantes
)
SELECT
  CASE WHEN funciones_del_bloque_restantes = 0 AND politica_restrictiva_restante = 0 AND politicas_con_predicado_v2 >= 4 AND predicado_igual_al_previo
        AND fila_config_sin_marcas_del_fixture = 1 AND atenciones_sinteticas_restantes = 0 AND pacientes_sinteticos_restantes = 0
        AND evoluciones_sinteticas_restantes = 0 AND resumenes_sinteticos_restantes = 0
       THEN 'ENSAYO OK: las 18 pruebas terminaron sin error y no quedo nada persistido'
       ELSE 'REVISAR: el ensayo no cerro limpio (ver las columnas)' END AS veredicto,
  v.*
FROM v;
