'use strict';
// tests/prerrequisitos-seguridad-clinica-v1.js — integración estática de los prerrequisitos recuperados de STAGING (partes 1-3), sus rollback, el ensayo de integración generado y el cliente de asociaciones.
// Sin red ni base: los SQL NO se ejecutan acá; el ensayo reversible en STAGING es la prueba de ejecución. Reutiliza (sin repetirlas) las suites aprobadas de 4C-1, 4B y asociaciones.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const leer = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const D = 'docs/propuestas/pending_review_seguridad_clinica_v1_';
const P1 = leer(D + 'p1_asociaciones.sql'), P1R = leer(D + 'p1_asociaciones_rollback.sql'), P2 = leer(D + 'p2_acceso_clinico.sql'), P2R = leer(D + 'p2_acceso_clinico_rollback.sql');
const P3 = leer(D + 'p3_hc_rls.sql'), P3R = leer(D + 'p3_hc_rls_rollback.sql'), ENSP = leer(D + 'ensayo_production.sql'), ENS = leer(D + 'ensayo_integracion.sql'), GEN = leer(D + 'generar_ensayo_integracion.sh'), DOC = leer(D + 'PUBLICACION.md');
const SINC = t => t.replace(/--[^\n]*/g, '');
const compacto = t => SINC(t).replace(/\s+/g, '').toLowerCase();
const inc = (t, f, m) => assert.ok(compacto(t).includes(compacto(f)), m || ('falta: ' + f.slice(0, 90)));
const pruebas = []; const prueba = (n, f) => pruebas.push({ n, f });

prueba('I1 los 3 SQL de aplicación: una transacción, precondiciones que abortan si ya está aplicado, postcondiciones y sin DML sobre datos', () => {
  for (const [n, t] of [['p1', P1], ['p2', P2], ['p3', P3]]) {
    const s = SINC(t);
    assert.equal((s.match(/^BEGIN;/gm) || []).length, 1, n); assert.equal((s.match(/^COMMIT;/gm) || []).length, 1, n); assert.match(t, /COMMIT;\s*$/, n);
    assert.ok(/Precondición/.test(t) && /Postcondición/.test(t), n);
    const sinDo = s.replace(/DO \$\$[\s\S]*?\$\$;/g, '').replace(/\$function\$[\s\S]*?\$function\$/g, '');
    assert.ok(!/\b(INSERT INTO|UPDATE |DELETE FROM|TRUNCATE)\b/i.test(sinDo.replace(/FOR UPDATE|BEFORE INSERT OR UPDATE|AFTER INSERT OR UPDATE/gi, '')), n + ': sin DML de datos');
    assert.ok(!/DROP\s+(TABLE|FUNCTION)/i.test(sinDo) || n === 'p3', n + ': los de aplicación no borran tablas ni funciones');
  }
  assert.ok(/ya está aplicado \(o parcialmente\)/.test(P1) && /ya está aplicado \(o parcialmente\)/.test(P2) && /RAISE EXCEPTION 'Precondición: se esperaban exactamente las dos políticas abiertas/.test(P3));
  inc(P2, "to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL"); inc(P3, "aplicar antes la PARTE 2");
});

prueba('I2 PARTE 1 (asociaciones): tablas con RLS y SIN acceso de anon/authenticated; RPC owner/admin; trigger de validación y de auditoría con actor', () => {
  for (const t of ['cardiolink_secretaria_medicos', 'cardiolink_secretaria_medicos_eventos_v1']) {
    inc(P1, `CREATE TABLE public.${t} (`); inc(P1, `ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
    inc(P1, `REVOKE ALL ON TABLE public.${t} FROM PUBLIC, anon, authenticated;`);
  }
  assert.ok(!/CREATE POLICY/i.test(SINC(P1)), 'las tablas de asociaciones no tienen políticas: solo se tocan por RPC / service_role');
  inc(P1, 'PRIMARY KEY (secretaria_user_id, medico_user_id)'); inc(P1, 'CHECK ((secretaria_user_id <> medico_user_id))'); inc(P1, 'actor uuid NOT NULL');
  const asoc = P1.match(/CREATE OR REPLACE FUNCTION public\.cardiolink_asociar_secretaria_medico_v1[\s\S]*?\$function\$;/)[0];
  inc(asoc, 'SECURITY DEFINER'); inc(asoc, "SET search_path TO 'pg_catalog', 'public'"); inc(asoc, "r.user_id=auth.uid() and r.active and r.base_role in ('owner','admin')"); inc(asoc, "using errcode='42501'");
  const lis = P1.match(/CREATE OR REPLACE FUNCTION public\.cardiolink_listar_asociaciones_v1[\s\S]*?\$function\$;/)[0];
  inc(lis, "r.base_role in ('owner','admin')"); inc(lis, 'SECURITY DEFINER');
  inc(P1, 'CREATE TRIGGER cardiolink_validar_asociacion_secretaria_medico_v1 BEFORE INSERT OR UPDATE'); inc(P1, 'CREATE TRIGGER cardiolink_secretaria_medicos_auditar_v1 AFTER INSERT OR UPDATE');
  inc(P1, "REVOKE ALL ON FUNCTION public.cardiolink_auditar_secretaria_medico_v1() FROM PUBLIC, anon, authenticated;");
  inc(P1, "GRANT EXECUTE ON FUNCTION public.cardiolink_asociar_secretaria_medico_v1(uuid, uuid, boolean) TO authenticated, service_role;");
  assert.ok(!/GRANT[^;]*\banon\b/i.test(SINC(P1)), 'nada para anon');
});

prueba('I3 PARTE 2 (acceso clínico): vínculos manuales solo por RPC owner/admin; predicado SECURITY DEFINER: owner/admin, médico con vínculo activo / evolución / atención propias; nunca Secretaría', () => {
  inc(P2, 'CREATE TABLE public.cardiolink_paciente_profesionales_v1 ('); inc(P2, "CHECK (((char_length(btrim(motivo)) >= 10) AND (char_length(btrim(motivo)) <= 300)))");
  inc(P2, "CHECK ((profesional_id ~ '^[a-z0-9_.-]{1,64}$'::text))"); inc(P2, 'REFERENCES auth.users(id)'); inc(P2, 'REFERENCES public.cardiolink_pacientes(id) ON DELETE CASCADE');
  assert.ok(!/CREATE POLICY/i.test(SINC(P2)));
  const as = P2.match(/CREATE OR REPLACE FUNCTION public\.cardiolink_asociar_paciente_profesional_v1[\s\S]*?\$function\$;/)[0];
  inc(as, "r.base_role in ('owner','admin')"); inc(as, "using errcode='42501'"); inc(as, "char_length(btrim(p_motivo)) not between 10 and 300");
  const ac = P2.match(/CREATE OR REPLACE FUNCTION public\.cardiolink_paciente_acceso_clinico_v1[\s\S]*?\$function\$;/)[0];
  inc(ac, 'SECURITY DEFINER'); inc(ac, "SET search_path TO 'pg_catalog', 'public'"); inc(ac, "if v_rol in ('owner','admin') then"); inc(ac, "if v_rol <> 'medico' or v_prof is null then return false; end if;");
  inc(ac, 'm.paciente_id=p_paciente_id and m.profesional_id=v_prof and m.activo'); inc(ac, 'cardiolink_hc_evoluciones e'); inc(ac, 'cardiolink_atenciones a'); assert.ok(!/secretaria/i.test(ac), 'la Secretaría no entra en el predicado');
  inc(P2, "GRANT EXECUTE ON FUNCTION public.cardiolink_paciente_acceso_clinico_v1(text) TO authenticated, service_role;");
});

prueba('I4 PARTE 3 (HC RLS): 8 políticas _v1, las abiertas se quitan en la MISMA transacción, Secretaría sin política; rollback las restaura idénticas', () => {
  const crea = SINC(P3).match(/CREATE POLICY [a-z_0-9]+_v1 ON public\.cardiolink_hc_(evoluciones|resumen)/g) || [];
  assert.equal(crea.length, 8);
  for (const t of ['evoluciones', 'resumen']) for (const c of ['delete', 'insert', 'select', 'update']) inc(P3, `CREATE POLICY cardiolink_hc_${t}_${c}_v1 ON public.cardiolink_hc_${t}`);
  assert.ok(!/secretaria/i.test(SINC(P3).replace(/--[^\n]*/g, '')), 'ninguna política menciona Secretaría (sin acceso)');
  inc(P3, "cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1()))");
  const iCrea = P3.indexOf('CREATE POLICY cardiolink_hc_evoluciones_delete_v1'), iDrop = P3.indexOf('DROP POLICY cardiolink_hc_evoluciones_authenticated');
  assert.ok(iCrea > 0 && iDrop > iCrea, 'primero se crean las nuevas y recién después se quitan las abiertas (sin ventana sin política)');
  inc(P3, "DROP POLICY cardiolink_hc_resumen_authenticated ON public.cardiolink_hc_resumen;");
  inc(P3R, 'CREATE POLICY cardiolink_hc_evoluciones_authenticated ON public.cardiolink_hc_evoluciones AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true);');
  inc(P3R, 'CREATE POLICY cardiolink_hc_resumen_authenticated ON public.cardiolink_hc_resumen AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true);');
  inc(P3, "qual='true' AND with_check='true'");
});

prueba('I5 rollback p1/p2: orden de dependencias y protección de datos (no destruyen filas sin confirmación explícita)', () => {
  for (const t of [P1R, P2R]) { inc(t, "current_setting('cardiolink.rollback_confirmado', true)"); inc(t, 'SET LOCAL cardiolink.rollback_confirmado'); assert.match(SINC(t), /^BEGIN;/m); assert.match(t, /COMMIT;\s*$/); }
  inc(P2R, 'revertir antes la PARTE 3'); inc(P2R, 'revertir antes 4C-1b y 4C-1'); inc(P1R, 'revertir antes 4C-1');
  inc(P1R, 'DROP TABLE public.cardiolink_secretaria_medicos;'); inc(P2R, 'DROP TABLE public.cardiolink_paciente_profesionales_v1;');
  assert.ok(!/DROP\s+(TABLE|FUNCTION)[^;]*CASCADE/i.test(SINC(P1R + P2R)), 'sin CASCADE');
});

prueba('I6 sin rastros de STAGING ni credenciales en los SQL de Production; sin service_role en cliente', () => {
  for (const t of [P1, P1R, P2, P2R, P3, P3R]) {
    assert.ok(!/yslhwdlzdknhskawqrtv|qa4c|sb_publishable_|sb_secret_|eyJ[A-Za-z0-9_-]{20,}|@[a-z0-9-]+\.(com|ar)\b/i.test(t));
  }
  assert.ok(!/service_role/.test(leer('cardiolink-asociaciones-ui-v1.js')));
  assert.ok(/cardiolink-asociaciones-ui-v1\.js\?v=2-prod/.test(leer('index.html')), 'el script de asociaciones lleva la versión nueva');
});

prueba('I7 ensayo de integración: solo STAGING, retrocede con los rollback en orden inverso, compara huellas, re-aplica p1-p3 y 4C-1/4C-1b, termina con excepción informativa (sin COMMIT)', () => {
  assert.equal((SINC(ENS).match(/^\s*COMMIT\s*;/gm) || []).length, 0);
  assert.equal((SINC(ENS).match(/^BEGIN;/gm) || []).length, 1);
  const ord = ['-- ---------- rollback 4C-1b', '-- ---------- rollback 4C-1 ', '-- ---------- rollback p3', '-- ---------- rollback p2', '-- ---------- rollback p1', '-- ---------- p1 ', '-- ---------- p2 ', '-- ---------- p3 ', '-- ---------- 4C-1 ', '-- ---------- 4C-1b '].map(x => ENS.indexOf(x));
  assert.ok(ord.every(x => x > 0) && ord.every((x, i) => i === 0 || x > ord[i - 1]), 'orden: ' + ord.join(','));
  inc(ENS, "INSERT INTO t_huella SELECT 'inicial', pg_temp.huella();"); inc(ENS, "INSERT INTO t_huella SELECT 'tras_p1_p2_p3', pg_temp.huella();"); inc(ENS, 'FALLA I5: la huella tras p1-p3 difiere de STAGING en');
  for (const x of ['FALLA I1', 'FALLA I2', 'FALLA I3', 'FALLA I4', 'FALLA I6', 'FALLA I7', 'FALLA I8', 'FALLA I9', 'FALLA I10', 'FALLA I11', 'ENSAYO_INTEGRACION_OK']) assert.ok(ENS.includes(x), x);
  inc(ENS, "SET LOCAL cardiolink.rollback_confirmado = 'si';"); assert.match(ENS, /ROLLBACK;\s*$/);
  assert.ok(/awk '!\(\/\^BEGIN;\$\/ \|\| \/\^COMMIT;\$\/\)'/.test(GEN), 'el generador quita BEGIN/COMMIT de los SQL de origen');
  // el ensayo contiene los SQL actuales (sincronía)
  for (const t of [P1, P2, P3]) { const cuerpo = SINC(t).replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, ''); assert.ok(compacto(ENS).includes(compacto(cuerpo)), 'el ensayo debe incluir el SQL vigente (regenerar con el script)'); }
});

prueba('I8 procedimiento de publicación: orden, dependencias, asociaciones, rollback y checks presentes', () => {
  for (const x of ['p1_asociaciones', 'p2_acceso_clinico', 'p3_hc_rls', 'POSTERGADO', 'config_secretaria_v1_a_rpc', 'config_secretaria_v1_b_rls', '4c1.sql', '4c1b_heredados.sql', 'Rollback', 'asociaciones', 'Geraldine', 'cliente', 'URLs firmadas']) assert.ok(DOC.includes(x), 'falta «' + x + '» en PUBLICACION.md');
});

prueba('I9 ALCANCE SIN p3 (HC RLS postergado): el ensayo de Production aplica p1, p2, 4B-A, 4B-B, 4C-1 y 4C-1b en orden, exige HC sin cambios y no incluye p3; 4C-1/4C-1b no dependen de las políticas de HC', () => {
  assert.equal((SINC(ENSP).match(/^\s*COMMIT\s*;/gm) || []).length, 0); assert.match(ENSP, /ROLLBACK;\s*$/); assert.ok(ENSP.includes('ENSAYO_PRODUCTION_OK'));
  const ord = ['-- ---------- p1 ', '-- ---------- p2 ', '-- ---------- 4B-A ', '-- ---------- 4B-B ', '-- ---------- 4C-1 ', '-- ---------- 4C-1b '].map(x => ENSP.indexOf(x));
  assert.ok(ord.every(x => x > 0) && ord.every((x, i) => i === 0 || x > ord[i - 1]), 'orden: ' + ord.join(','));
  assert.ok(!/-- ---------- p3/.test(ENSP) && !/CREATE POLICY cardiolink_hc_/.test(SINC(ENSP)) && !/DROP POLICY cardiolink_hc_/.test(SINC(ENSP)), 'p3 no está en el ensayo de Production');
  inc(ENSP, "FALLA P5: p3 está postergado: las políticas de HC deben quedar como están (2 abiertas, 0 _v1)");
  // 4C-1 / 4C-1b: ninguna política ni función SQL de 4C-1 lee HC fuera de funciones SECURITY DEFINER; ninguna menciona las políticas _v1 de HC
  const c4 = leer('docs/propuestas/pending_review_documentos_seguridad_4c1.sql'), c4b = leer('docs/propuestas/pending_review_documentos_seguridad_4c1b_heredados.sql');
  for (const t of [c4, c4b]) assert.ok(!/cardiolink_hc_(evoluciones|resumen)_(select|insert|update|delete)_v1/.test(t));
  const sinFunciones = SINC(c4).replace(/CREATE FUNCTION[\s\S]*?\$f\$;/g, '').replace(/CREATE FUNCTION[\s\S]*?SECURITY DEFINER[\s\S]*?(?=\n\n|CREATE )/g, '');
  assert.ok(!/cardiolink_hc_(evoluciones|resumen)/.test(sinFunciones.replace(/IF to_regclass[^;]*;/g, '').replace(/RAISE EXCEPTION[^;]*;/g, '')), '4C-1 solo lee HC dentro de funciones SECURITY DEFINER (o en precondiciones)');
  inc(DOC, 'p3 puede postergarse sin afectar la seguridad documental'); inc(DOC, 'Rogelio dejaría de ver 141 de 176 documentos');
  inc(DOC, 'hc_politicas_abiertas_de_2=2');
});

(async () => {
  let fallas = 0;
  for (const p of pruebas) { try { await p.f(); console.log('PASS  ' + p.n); } catch (e) { fallas++; console.log('FAIL  ' + p.n + '\n      ' + (e && e.message || e)); } }
  console.log('\n' + (pruebas.length - fallas) + '/' + pruebas.length + ' pruebas OK'); if (fallas) process.exitCode = 1;
})();
