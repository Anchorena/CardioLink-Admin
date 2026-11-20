-- CardioLink · Seguridad clínica V1 · p3c · D5 APROBADA (2026-11-20) · ENDURECIMIENTO DE PRIVILEGIOS de las 2 tablas de HC (parte de la publicación de p3c).
-- NO EJECUTAR en Production sin autorización explícita. Una sola transacción. Rollback: …_p3c_grants_hc_rollback.sql
-- Hallazgo: Supabase otorga por defecto a anon y authenticated TODOS los privilegios de tabla. La RLS sólo cubre SELECT/INSERT/UPDATE/DELETE: TRUNCATE (en Production, anon y authenticated lo tienen), TRIGGER y REFERENCES NO pasan por RLS.
-- PostgREST no expone TRUNCATE, así que no era explotable por la API; esto es defensa en profundidad.
-- Efecto: anon y PUBLIC pierden todo. authenticated conserva EXACTAMENTE SELECT/INSERT/UPDATE/DELETE (lo que usan los médicos y las políticas RLS, que siguen filtrando); pierde TRUNCATE, TRIGGER y REFERENCES.
-- No afecta a service_role (edge functions) ni a las funciones SECURITY DEFINER (corren como su dueño). Sin privilegios por columna ni WITH GRANT OPTION (se verifica).
BEGIN;
REVOKE ALL ON TABLE public.cardiolink_hc_evoluciones, public.cardiolink_hc_resumen FROM PUBLIC, anon;
REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE public.cardiolink_hc_evoluciones, public.cardiolink_hc_resumen FROM authenticated;
DO $$
DECLARE t text; p text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.cardiolink_hc_evoluciones','public.cardiolink_hc_resumen'] LOOP
    -- anon: ningún privilegio de tabla ni de columna
    FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
      IF has_table_privilege('anon', t, p) THEN RAISE EXCEPTION 'Postcondición: anon conserva % sobre %', p, t; END IF;
    END LOOP;
    IF has_any_column_privilege('anon', t, 'SELECT') OR has_any_column_privilege('anon', t, 'INSERT') OR has_any_column_privilege('anon', t, 'UPDATE') OR has_any_column_privilege('anon', t, 'REFERENCES') THEN RAISE EXCEPTION 'Postcondición: anon con privilegios por columna sobre %', t; END IF;
    -- authenticated: exactamente SELECT/INSERT/UPDATE/DELETE
    FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
      IF NOT has_table_privilege('authenticated', t, p) THEN RAISE EXCEPTION 'Postcondición: authenticated perdió % sobre % (lo necesitan las políticas RLS)', p, t; END IF;
    END LOOP;
    FOREACH p IN ARRAY ARRAY['TRUNCATE','REFERENCES','TRIGGER'] LOOP
      IF has_table_privilege('authenticated', t, p) THEN RAISE EXCEPTION 'Postcondición: authenticated conserva % sobre %', p, t; END IF;
    END LOOP;
    -- nadie con GRANT OPTION ni PUBLIC (grantee 0) en la ACL
    IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = t::regclass AND (a.grantee = 0 OR (a.is_grantable AND a.grantee::regrole::text IN ('anon','authenticated')))) THEN RAISE EXCEPTION 'Postcondición: ACL con PUBLIC o GRANT OPTION sobre %', t; END IF;
  END LOOP;
END $$;
COMMIT;
