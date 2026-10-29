const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 8002;
const POKEAPI = "https://pokeapi.co/api/v2";

app.use(express.json());
app.use(cors());
// Express 5: req.body puede venir undefined si no hay cuerpo
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

const cachePokemon = {};
const cacheMovimientos = {};

const FALLBACK = {
  nombre: "Placaje",
  nombreEn: "Tackle",
  poder: 40,
  precision: 100,
  tipo: "normal",
  clase: "physical",
};

app.get("/", (req, res) => {
  res.json({ mensaje: "Servidor de Pokémon Arena funcionando correctamente." });
});

// ==================== Helpers PokéAPI ====================
async function obtenerPokemon(id) {
  if (cachePokemon[id]) return cachePokemon[id];

  const [r1, r2] = await Promise.all([
    fetch(`${POKEAPI}/pokemon/${id}`),
    fetch(`${POKEAPI}/pokemon-species/${id}`),
  ]);
  if (!r1.ok) throw new Error(`Pokémon ${id} no encontrado`);

  const p = await r1.json();
  const especie = r2.ok ? await r2.json() : {};
  const bw = p.sprites.versions?.["generation-v"]?.["black-white"];

  const data = {
    id: p.id,
    nombre: p.name,
    tipos: p.types.map((t) => t.type.name),
    estadisticas: Object.fromEntries(
      p.stats.map((s) => [s.stat.name, s.base_stat]),
    ),
    sprites: {
      pixel: p.sprites.front_default,
      oficial: p.sprites.other?.["official-artwork"]?.front_default ?? null,
      frente: bw?.front_default ?? p.sprites.front_default,
      espalda:
        bw?.back_default ?? p.sprites.back_default ?? p.sprites.front_default,
    },
    grito: p.cries?.latest ?? null,
    legendario: !!(especie.is_legendary || especie.is_mythical),
  };
  cachePokemon[id] = data;
  return data;
}

async function obtenerMovimientos(id) {
  if (cacheMovimientos[id]) return cacheMovimientos[id];

  const r = await fetch(`${POKEAPI}/pokemon/${id}`);
  if (!r.ok) throw new Error("Pokémon no encontrado");
  const p = await r.json();

  const candidatos = p.moves
    .map((m) => m.move.name)
    .sort(() => Math.random() - 0.5)
    .slice(0, 12);

  const detalles = await Promise.all(
    candidatos.map((n) =>
      fetch(`${POKEAPI}/move/${n}`)
        .then((x) => (x.ok ? x.json() : null))
        .catch(() => null),
    ),
  );

  const movs = detalles
    .filter((m) => m && m.power && m.damage_class.name !== "status")
    .slice(0, 4)
    .map((m) => ({
      nombre: m.names.find((n) => n.language.name === "es")?.name ?? m.name,
      nombreEn: m.names.find((n) => n.language.name === "en")?.name ?? m.name,
      poder: m.power,
      precision: m.accuracy ?? 100,
      tipo: m.type.name,
      clase: m.damage_class.name,
    }));

  if (movs.length === 0) movs.push(FALLBACK);
  cacheMovimientos[id] = movs;
  return movs;
}

async function generarPool(cantidad, excluir, permitirLegendarios) {
  const usados = new Set(excluir);
  const pool = [];

  while (pool.length < cantidad) {
    const faltan = cantidad - pool.length;
    const candidatos = [];
    while (candidatos.length < faltan + 2) {
      const id = Math.floor(Math.random() * 151) + 1;
      if (!usados.has(id) && !candidatos.includes(id)) candidatos.push(id);
    }
    const resultados = await Promise.all(
      candidatos.map((id) => obtenerPokemon(id).catch(() => null)),
    );
    for (const p of resultados) {
      if (!p || usados.has(p.id)) continue;
      if (!permitirLegendarios && p.legendario) continue;
      if (pool.length >= cantidad) break;
      usados.add(p.id);
      pool.push(p);
    }
  }
  return pool;
}

async function precalentar() {
  const ids = Array.from({ length: 151 }, (_, i) => i + 1);
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(
      ids.slice(i, i + 10).map((id) => obtenerPokemon(id).catch(() => null)),
    );
  }
  console.log("Caché de Pokémon lista");
}

// ==================== Endpoints VS PC ====================
app.get("/api/arena/pool", async (req, res) => {
  try {
    const pool = await generarPool(10, [], req.query.legendarios === "true");
    res.json({ exito: true, pokemonPool: pool });
    pool.forEach((p) => obtenerMovimientos(p.id).catch(() => {}));
  } catch (error) {
    console.error("Error al generar el pool:", error);
    res.status(502).json({ error: "No fue posible conectar con la PokéAPI." });
  }
});

app.get("/api/arena/rival", async (req, res) => {
  try {
    const excluir = (req.query.excluir || "")
      .split(",")
      .map(Number)
      .filter(Boolean);
    const rival = await generarPool(
      3,
      excluir,
      req.query.legendarios === "true",
    );
    res.json({ exito: true, equipoRival: rival });
    rival.forEach((p) => obtenerMovimientos(p.id).catch(() => {}));
  } catch (error) {
    console.error("Error al generar rival:", error);
    res.status(502).json({ error: "No fue posible conectar con la PokéAPI." });
  }
});

app.get("/api/arena/pokemon/:id/movimientos", async (req, res) => {
  try {
    const movimientos = await obtenerMovimientos(req.params.id);
    res.json({ exito: true, movimientos });
  } catch (error) {
    console.error("Error en movimientos:", error);
    res.json({ exito: true, movimientos: [FALLBACK] });
  }
});

// ==================== MODO ONLINE ====================
// El servidor es el árbitro: calcula cada turno y los dos celulares lo reproducen.

const TABLA = {
  normal: { x05: ["rock", "steel"], x0: ["ghost"] },
  fire: {
    x2: ["grass", "ice", "bug", "steel"],
    x05: ["fire", "water", "rock", "dragon"],
  },
  water: { x2: ["fire", "ground", "rock"], x05: ["water", "grass", "dragon"] },
  electric: {
    x2: ["water", "flying"],
    x05: ["electric", "grass", "dragon"],
    x0: ["ground"],
  },
  grass: {
    x2: ["water", "ground", "rock"],
    x05: ["fire", "grass", "poison", "flying", "bug", "dragon", "steel"],
  },
  ice: {
    x2: ["grass", "ground", "flying", "dragon"],
    x05: ["fire", "water", "ice", "steel"],
  },
  fighting: {
    x2: ["normal", "ice", "rock", "dark", "steel"],
    x05: ["poison", "flying", "psychic", "bug", "fairy"],
    x0: ["ghost"],
  },
  poison: {
    x2: ["grass", "fairy"],
    x05: ["poison", "ground", "rock", "ghost"],
    x0: ["steel"],
  },
  ground: {
    x2: ["fire", "electric", "poison", "rock", "steel"],
    x05: ["grass", "bug"],
    x0: ["flying"],
  },
  flying: {
    x2: ["grass", "fighting", "bug"],
    x05: ["electric", "rock", "steel"],
  },
  psychic: {
    x2: ["fighting", "poison"],
    x05: ["psychic", "steel"],
    x0: ["dark"],
  },
  bug: {
    x2: ["grass", "psychic", "dark"],
    x05: ["fire", "fighting", "poison", "flying", "ghost", "steel", "fairy"],
  },
  rock: {
    x2: ["fire", "ice", "flying", "bug"],
    x05: ["fighting", "ground", "steel"],
  },
  ghost: { x2: ["psychic", "ghost"], x05: ["dark"], x0: ["normal"] },
  dragon: { x2: ["dragon"], x05: ["steel"], x0: ["fairy"] },
  dark: { x2: ["psychic", "ghost"], x05: ["fighting", "dark", "fairy"] },
  steel: {
    x2: ["ice", "rock", "fairy"],
    x05: ["fire", "water", "electric", "steel"],
  },
  fairy: {
    x2: ["fighting", "dragon", "dark"],
    x05: ["fire", "poison", "steel"],
  },
};

// Bonus de escenario: x1.5 al daño de los tipos favorecidos (igual que la app)
const MULT_ESC = 1.5;
const BONUS = {
  volcan: ["fire"],
  cueva: ["ground", "rock"],
  playa: ["water", "electric"],
  bosque: ["grass", "bug"],
};

// Multiplicadores de tipo (iguales a los de battle-page.ts)
const MULT_SUPER = 2.5; // ventaja de tipo
const MULT_POCO = 0.4; // desventaja de tipo

function efectividad(tipoMov, tiposDef) {
  const fila = TABLA[tipoMov];
  if (!fila) return 1;
  let m = 1;
  for (const t of tiposDef) {
    if (fila.x0?.includes(t)) return 0;
    if (fila.x2?.includes(t)) m *= MULT_SUPER;
    if (fila.x05?.includes(t)) m *= MULT_POCO;
  }
  return m;
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, " ");
}

function crearLuchador(p, movs) {
  const s = p.estadisticas;
  const hp = s["hp"] + 60;
  return {
    base: p,
    nombre: cap(p.nombre),
    tipos: p.tipos,
    hpMax: hp,
    hp,
    atk: s["attack"] + 5,
    def: s["defense"] + 5,
    spa: (s["special-attack"] ?? s["attack"]) + 5,
    spd: (s["special-defense"] ?? s["defense"]) + 5,
    vel: s["speed"] + 5,
    movimientos: movs && movs.length ? movs : [FALLBACK],
  };
}

function calcularDanio(att, def, mov, escenarioId) {
  const especial = mov.clase === "special";
  const a = especial ? att.spa : att.atk;
  const d = especial ? def.spd : def.def;
  const ef = efectividad(mov.tipo, def.tipos);
  if (ef === 0) return { dano: 0, ef, crit: false };

  const stab = att.tipos.includes(mov.tipo) ? 1.5 : 1;
  const bonoEsc = (BONUS[escenarioId] || []).includes(mov.tipo) ? MULT_ESC : 1;
  const crit = Math.random() < 0.0625;
  const azar = 0.85 + Math.random() * 0.15;
  const base = Math.floor((22 * mov.poder * a) / d / 50) + 2;
  const dano = Math.max(
    1,
    Math.floor(base * stab * ef * bonoEsc * (crit ? 1.5 : 1) * azar),
  );
  return { dano, ef, crit };
}

const salas = {};

function limpiarNombre(n) {
  const limpio = String(n || "")
    .replace(/[^\p{L}\p{N} _.-]/gu, "")
    .trim()
    .substring(0, 12);
  return limpio || "Entrenador";
}

function generarCodigo() {
  const letras = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c;
  do {
    c = Array.from(
      { length: 5 },
      () => letras[Math.floor(Math.random() * letras.length)],
    ).join("");
  } while (salas[c]);
  return c;
}

function salaDe(codigo) {
  const s = salas[String(codigo || "").toUpperCase()];
  if (s) s.ultimaActividad = Date.now();
  return s;
}

// Cola por sala: evita que los dos jugadores reciban Pokémon repetidos
function enCola(s, fn) {
  const p = (s.cola || Promise.resolve()).then(fn);
  s.cola = p.catch(() => {});
  return p;
}

function publico(l, conMovs) {
  return {
    nombre: l.nombre,
    tipos: l.tipos,
    hpMax: l.hpMax,
    sprites: l.base.sprites,
    grito: l.base.grito,
    movimientos: conMovs ? l.movimientos : undefined,
  };
}

function resolverTurno(s) {
  const [idA, idB] = s.orden;
  // Cada jugador tiene su propio Pokémon activo: solo cambia el que cae
  const lA = s.jugadores[idA].equipo[s.activo[idA]];
  const lB = s.jugadores[idB].equipo[s.activo[idB]];
  const mA = lA.movimientos[s.acciones[idA]] || lA.movimientos[0];
  const mB = lB.movimientos[s.acciones[idB]] || lB.movimientos[0];

  const aPrimero =
    lA.vel > lB.vel || (lA.vel === lB.vel && Math.random() < 0.5);
  const orden = aPrimero
    ? [
        [idA, idB, lA, lB, mA],
        [idB, idA, lB, lA, mB],
      ]
    : [
        [idB, idA, lB, lA, mB],
        [idA, idB, lA, lB, mA],
      ];

  const eventos = [];
  for (const [id, idDef, att, def, mov] of orden) {
    if (att.hp <= 0) continue;
    eventos.push({
      t: "usa",
      quien: id,
      nombre: att.nombre,
      mov: mov.nombre,
      movEn: mov.nombreEn,
      tipo: mov.tipo,
    });

    if (Math.random() * 100 > mov.precision) {
      eventos.push({ t: "falla", quien: id });
      continue;
    }
    const r = calcularDanio(att, def, mov, s.escenario);
    def.hp = Math.max(0, def.hp - r.dano);
    eventos.push({
      t: "dano",
      quien: id,
      tipo: mov.tipo,
      dano: r.dano,
      hpDef: def.hp,
      ef: r.ef,
      crit: r.crit,
    });
    if (def.hp <= 0) {
      eventos.push({ t: "desmayo", quien: idDef });
      break;
    }
  }

  if (lA.hp <= 0 || lB.hp <= 0) {
    const caidoId = lA.hp <= 0 ? idA : idB;
    const ganadorId = caidoId === idA ? idB : idA;
    s.puntos[ganadorId]++; // puntos = Pokémon rivales derrotados
    s.activo[caidoId]++; // solo el Pokémon que cayó es reemplazado
    eventos.push({
      t: "finRonda",
      ganador: ganadorId,
      perdedor: caidoId,
      puntos: { ...s.puntos },
    });

    if (s.puntos[ganadorId] === 3) {
      // el equipo del rival se quedó sin Pokémon
      s.estado = "fin";
      s.ganador = ganadorId;
      eventos.push({ t: "finJuego", ganador: s.ganador });
    } else {
      s.ronda++;
    }
  }

  s.turnos.push({ n: s.turno, eventos });
  s.turno++;
  s.acciones = {};
}

// Crear sala
app.post("/api/online/crear", (req, res) => {
  const { jugadorId, escenario, nombre } = req.body;
  if (!jugadorId) return res.status(400).json({ error: "Falta el jugador." });

  const codigo = generarCodigo();
  const esc = BONUS[escenario] ? escenario : "volcan";
  salas[codigo] = {
    codigo,
    escenario: esc,
    estado: "esperando", // esperando -> eligiendo -> batalla -> fin
    orden: [jugadorId],
    jugadores: {
      [jugadorId]: {
        id: jugadorId,
        nombre: limpiarNombre(nombre),
        pool: [],
        equipo: null,
        ping: Date.now(),
      },
    },
    ronda: 1,
    activo: { [jugadorId]: 0 }, // índice del Pokémon en combate de cada jugador
    turno: 0,
    acciones: {},
    turnos: [],
    puntos: { [jugadorId]: 0 },
    ganador: null,
    abandono: false,
    ultimaActividad: Date.now(),
  };
  res.json({ exito: true, codigo, escenario: esc });
});

// Unirse a sala
app.post("/api/online/unirse", (req, res) => {
  const { codigo, jugadorId, nombre } = req.body;
  const s = salaDe(codigo);
  if (!s)
    return res.status(404).json({ error: "Esa sala no existe o ya expiró." });
  if (!jugadorId) return res.status(400).json({ error: "Falta el jugador." });

  if (!s.jugadores[jugadorId]) {
    if (s.orden.length >= 2)
      return res.status(409).json({ error: "La sala ya está llena." });
    s.orden.push(jugadorId);
    s.jugadores[jugadorId] = {
      id: jugadorId,
      nombre: limpiarNombre(nombre),
      pool: [],
      equipo: null,
      ping: Date.now(),
    };
    s.puntos[jugadorId] = 0;
    s.activo[jugadorId] = 0;
    s.estado = "eligiendo";
  }
  res.json({ exito: true, codigo: s.codigo, escenario: s.escenario });
});

// Pool de 10 propio (sin repetir los del rival)
app.get("/api/online/:codigo/pool", async (req, res) => {
  const s = salaDe(req.params.codigo);
  if (!s)
    return res.status(404).json({ error: "La sala no existe o ya expiró." });
  const j = s.jugadores[req.query.jugadorId];
  if (!j) return res.status(403).json({ error: "No perteneces a esta sala." });

  try {
    if (!j.equipo && j.pool.length === 0) {
      await enCola(s, async () => {
        const otro = Object.values(s.jugadores).find((x) => x.id !== j.id);
        const excluir = otro ? otro.pool.map((p) => p.id) : [];
        j.pool = await generarPool(10, excluir, false);
      });
    }
    res.json({ exito: true, pokemonPool: j.pool });
    j.pool.forEach((p) => obtenerMovimientos(p.id).catch(() => {}));
  } catch (error) {
    console.error("Error pool online:", error);
    res.status(502).json({ error: "No fue posible conectar con la PokéAPI." });
  }
});

// Enviar equipo (3 ids del pool)
app.post("/api/online/:codigo/equipo", async (req, res) => {
  const s = salaDe(req.params.codigo);
  if (!s)
    return res.status(404).json({ error: "La sala no existe o ya expiró." });
  const j = s.jugadores[req.body.jugadorId];
  if (!j) return res.status(403).json({ error: "No perteneces a esta sala." });
  if (j.equipo) return res.json({ exito: true });

  const ids = (req.body.ids || []).map(Number);
  if (ids.length !== 3 || new Set(ids).size !== 3) {
    return res
      .status(400)
      .json({ error: "Debes elegir exactamente 3 Pokémon distintos." });
  }
  const elegidos = ids.map((id) => j.pool.find((p) => p.id === id));
  if (elegidos.some((p) => !p)) {
    return res
      .status(400)
      .json({ error: "Alguno de los Pokémon no está en tu pool." });
  }

  try {
    const movs = await Promise.all(
      elegidos.map((p) => obtenerMovimientos(p.id).catch(() => [FALLBACK])),
    );
    j.equipo = elegidos.map((p, i) => crearLuchador(p, movs[i]));
    j.ping = Date.now();

    if (s.orden.length === 2 && s.orden.every((id) => s.jugadores[id].equipo)) {
      s.estado = "batalla";
    }
    res.json({ exito: true });
  } catch (error) {
    console.error("Error al guardar equipo:", error);
    res.status(500).json({ error: "No se pudo guardar el equipo." });
  }
});

// Estado de la sala (el celular lo consulta cada ~1.2 s)
app.get("/api/online/:codigo/estado", (req, res) => {
  const s = salaDe(req.params.codigo);
  if (!s)
    return res.status(404).json({ error: "La sala no existe o ya expiró." });
  const j = s.jugadores[req.query.jugadorId];
  if (!j) return res.status(403).json({ error: "No perteneces a esta sala." });
  j.ping = Date.now();

  const rivalId = s.orden.find((id) => id !== j.id) || null;
  const r = rivalId ? s.jugadores[rivalId] : null;
  const desde = Number(req.query.desde) || 0;

  const out = {
    exito: true,
    estado: s.estado,
    escenario: s.escenario,
    hayRival: !!r,
    listoRival: !!(r && r.equipo),
    rivalNombre: r ? r.nombre : "Rival",
    rivalId,
    ronda: s.ronda,
    turno: s.turno,
    puntos: s.puntos,
    ganador: s.ganador,
    abandono: s.abandono,
    rivalDesconectado:
      r && s.estado === "batalla" ? Date.now() - r.ping > 20000 : false,
    turnos: s.turnos.filter((t) => t.n >= desde),
  };

  if (
    (s.estado === "batalla" || s.estado === "fin") &&
    j.equipo &&
    r &&
    r.equipo
  ) {
    out.yo = { equipo: j.equipo.map((l) => publico(l, true)) };
    out.rival = { equipo: r.equipo.map((l) => publico(l, false)) };
  }
  res.json(out);
});

// Elegir movimiento del turno
app.post("/api/online/:codigo/accion", (req, res) => {
  const s = salaDe(req.params.codigo);
  if (!s)
    return res.status(404).json({ error: "La sala no existe o ya expiró." });
  const { jugadorId, ronda, turno, mov } = req.body;
  const j = s.jugadores[jugadorId];
  if (!j) return res.status(403).json({ error: "No perteneces a esta sala." });
  if (s.estado !== "batalla")
    return res.status(409).json({ error: "La batalla no está activa." });
  if (ronda !== s.ronda || turno !== s.turno) {
    return res
      .status(409)
      .json({ error: "Turno desfasado, vuelve a intentar." });
  }
  j.ping = Date.now();

  const idx = Number(mov);
  const luchador = j.equipo[s.activo[jugadorId]];
  if (!Number.isInteger(idx) || idx < 0 || idx >= luchador.movimientos.length) {
    return res.status(400).json({ error: "Movimiento inválido." });
  }

  if (s.acciones[jugadorId] === undefined) s.acciones[jugadorId] = idx;
  if (s.orden.every((id) => s.acciones[id] !== undefined)) resolverTurno(s);
  res.json({ exito: true });
});

// Rendirse / abandonar
app.post("/api/online/:codigo/abandonar", (req, res) => {
  const s = salaDe(req.params.codigo);
  if (!s) return res.json({ exito: true });
  const { jugadorId } = req.body;
  if (s.jugadores[jugadorId] && s.estado !== "fin") {
    s.estado = "fin";
    s.abandono = true;
    s.ganador = s.orden.find((id) => id !== jugadorId) || null;
  }
  res.json({ exito: true });
});

// Limpieza de salas viejas (más de 3 horas sin actividad)
setInterval(
  () => {
    const limite = Date.now() - 3 * 60 * 60 * 1000;
    for (const c of Object.keys(salas)) {
      if (salas[c].ultimaActividad < limite) delete salas[c];
    }
  },
  10 * 60 * 1000,
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  precalentar();
});
