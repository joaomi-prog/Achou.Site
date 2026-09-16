// Backend da plataforma "achou.site"
// Usa só a Overpass API (OpenStreetMap): localiza a cidade e busca os
// estabelecimentos do nicho escolhido numa única consulta, filtrando quem
// não tem o campo "website" preenchido. Gratuito, sem chave, sem cartão.
//
// Observação: usamos admin_level=8 (nível de município no Brasil) pra achar
// a área certa da cidade, em vez de depender do Nominatim, que costuma
// bloquear IPs residenciais com frequência.

import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json());

const USER_AGENT = "achou-site-prototipo (contato@example.com)";

// Cliente Supabase com a chave SECRETA (service_role) — só existe aqui no
// backend, nunca no frontend. Ela ignora as regras de RLS, então usamos ela
// com cuidado, só nos pontos onde realmente precisamos (gerar/ativar chave).
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Middleware: confirma quem é o usuário logado a partir do token que o
// frontend manda no cabeçalho "Authorization: Bearer <token>".
// Usamos um cliente NOVO e descartável aqui de propósito — se reaproveitássemos
// o "supabaseAdmin", essa verificação de login "contaminaria" ele com o token
// do usuário comum, fazendo ele perder o poder de ignorar o RLS depois.
async function exigirLogin(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) return res.status(401).json({ erro: "Não autenticado." });

  const clienteVerificador = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await clienteVerificador.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ erro: "Sessão inválida." });

  req.usuario = data.user;
  next();
}

// Middleware: além de logado, exige que o perfil tenha is_admin = true.
async function exigirAdmin(req, res, next) {
  const { data: perfil, error } = await supabaseAdmin
    .from("perfis")
    .select("is_admin")
    .eq("id", req.usuario.id)
    .single();

  console.log("Checagem de admin — usuario_id:", req.usuario.id, "| perfil encontrado:", perfil, "| erro:", error);

  if (error || !perfil || !perfil.is_admin) {
    return res.status(403).json({ erro: "Só o administrador pode fazer isso." });
  }
  next();
}

function gerarCodigoChave() {
  const alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem letras/números ambíguos (0,O,1,I)
  const bloco = () => Array.from({ length: 4 }, () => alfabeto[Math.floor(Math.random() * alfabeto.length)]).join("");
  return `${bloco()}-${bloco()}-${bloco()}-${bloco()}`;
}

// Cada nicho vira um ou mais filtros de tag do OpenStreetMap.
// Referência de tags: https://wiki.openstreetmap.org/wiki/Map_features
const NICHO_PARA_FILTROS = {
  barbearia: ['["shop"="hairdresser"]', '["shop"="barber"]'],
  petshop: ['["shop"="pet"]'],
  hamburgueria: ['["amenity"="fast_food"]["cuisine"~"burger",i]', '["amenity"="restaurant"]["cuisine"~"burger",i]'],
  salao: ['["shop"="beauty"]'],
  pizzaria: ['["amenity"="restaurant"]["cuisine"~"pizza",i]', '["amenity"="fast_food"]["cuisine"~"pizza",i]'],
  academia: ['["leisure"="fitness_centre"]'],
  restaurante: ['["amenity"="restaurant"]'],
  doceria: ['["shop"="confectionery"]', '["shop"="pastry"]'],
  lavajato: ['["amenity"="car_wash"]'],
  oficina: ['["shop"="car_repair"]'],
  clinica_odonto: ['["amenity"="dentist"]'],
  loja_roupas: ['["shop"="clothes"]'],
  papelaria: ['["shop"="stationery"]'],
  mercado: ['["shop"="convenience"]', '["shop"="supermarket"]'],
  floricultura: ['["shop"="florist"]'],
};

function normalizar(str) {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

// Caixas de coordenadas aproximadas [sul, oeste, norte, leste] das cidades
// suportadas. Buscar por uma caixa é muito mais rápido pro Overpass do que
// calcular se cada ponto está dentro do contorno administrativo da cidade,
// especialmente em cidades grandes como São Paulo.
const BBOX_CIDADES = {
  "sao paulo": [-23.75, -46.826, -23.36, -46.365],
  "campinas": [-23.02, -47.2, -22.75, -46.9],
  "guarulhos": [-23.55, -46.6, -23.35, -46.3],
  "sao bernardo do campo": [-23.85, -46.62, -23.6, -46.45],
  "santo andre": [-23.75, -46.6, -23.6, -46.45],
  "ribeirao preto": [-21.3, -47.9, -21.05, -47.65],
  "sorocaba": [-23.6, -47.55, -23.35, -47.35],
  "sao jose dos campos": [-23.35, -45.95, -23.05, -45.7],
  "santos": [-24.05, -46.42, -23.9, -46.25],
  "maua": [-23.75, -46.5, -23.6, -46.35],
  "piracicaba": [-22.8, -47.75, -22.6, -47.55],
  "bauru": [-22.4, -49.15, -22.25, -48.95],
  "sao jose do rio preto": [-20.9, -49.5, -20.7, -49.3],
  "jundiai": [-23.25, -47.0, -23.1, -46.8],
  "franca": [-20.65, -47.5, -20.45, -47.3],
  "vargem grande do sul": [-21.9, -46.95, -21.8, -46.8],
  "sao carlos": [-22.1, -47.95, -21.9, -47.75],
  "araraquara": [-21.9, -48.25, -21.7, -48.05],
  "presidente prudente": [-22.2, -51.45, -22.05, -51.3],
  "limeira": [-22.65, -47.5, -22.45, -47.3],
  // Região de Vargem Grande do Sul (Circuito das Águas Paulista)
  "sao joao da boa vista": [-21.99, -46.85, -21.87, -46.72],
  "aguas da prata": [-21.95, -46.75, -21.88, -46.68],
  "casa branca": [-21.82, -47.1, -21.72, -47.0],
  "espirito santo do pinhal": [-22.23, -46.76, -22.13, -46.64],
  "mococa": [-21.52, -47.05, -21.42, -46.92],
  "aguai": [-22.1, -46.99, -22.0, -46.88],
  "itobi": [-21.79, -46.95, -21.72, -46.85],
};

const SERVIDORES_OVERPASS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

async function chamarOverpassComRetry(query) {
  let ultimoErro;

  for (const servidor of SERVIDORES_OVERPASS) {
    try {
      const resp = await fetch(servidor, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "*/*",
          "User-Agent": USER_AGENT,
        },
        body: `data=${encodeURIComponent(query)}`,
      });

      const textoBruto = await resp.text();
      if (!resp.ok) {
        console.warn(`Servidor ${servidor} falhou (status ${resp.status}), tentando o próximo...`);
        ultimoErro = new Error(`Overpass API bloqueou a requisição (status ${resp.status}).`);
        continue;
      }

      try {
        return JSON.parse(textoBruto);
      } catch (e) {
        console.warn(`Servidor ${servidor} não retornou JSON válido, tentando o próximo...`);
        ultimoErro = new Error("Overpass API não retornou dados válidos.");
        continue;
      }
    } catch (e) {
      console.warn(`Servidor ${servidor} falhou (${e.message}), tentando o próximo...`);
      ultimoErro = e;
      continue;
    }
  }

  throw ultimoErro || new Error("Todos os servidores Overpass falharam.");
}

async function buscarNaOverpass(cidadeInput, nicho) {
  // "Campinas, SP" -> "Campinas"
  const nomeCidade = cidadeInput.split(",")[0].trim();
  const filtros = NICHO_PARA_FILTROS[nicho] || [`["shop"]`];
  const bbox = BBOX_CIDADES[normalizar(nomeCidade)];

  let blocos;
  if (bbox) {
    // Caminho rápido: cidade conhecida, busca só dentro da caixa de coordenadas
    const bboxStr = bbox.join(",");
    blocos = filtros
      .map((f) => `  node${f}(${bboxStr});\n  way${f}(${bboxStr});`)
      .join("\n");
  } else {
    // Caminho alternativo (mais lento): cidade fora da lista conhecida,
    // busca pelo contorno administrativo do OpenStreetMap.
    blocos = filtros
      .map((f) => `  node${f}(area.searchArea);\n  way${f}(area.searchArea);`)
      .join("\n");
  }

  const query = bbox
    ? `
    [out:json][timeout:30];
    (
    ${blocos}
    );
    out center tags;
  `
    : `
    [out:json][timeout:60];
    area["name"="${nomeCidade}"]["boundary"="administrative"]["admin_level"="8"]->.searchArea;
    (
    ${blocos}
    );
    out center tags;
  `;

  const data = await chamarOverpassComRetry(query);
  return data.elements || [];
}

function montarEndereco(tags) {
  const partes = [
    tags["addr:street"],
    tags["addr:housenumber"],
    tags["addr:suburb"] || tags["addr:neighbourhood"],
    tags["addr:city"],
  ].filter(Boolean);
  return partes.length ? partes.join(", ") : null;
}

app.get("/api/buscar", async (req, res) => {
  try {
    const { cidade, nicho } = req.query;

    if (!cidade || !nicho) {
      return res.status(400).json({ erro: "Informe 'cidade' e 'nicho' na query string." });
    }

    const elementos = await buscarNaOverpass(cidade, nicho);

    const vistos = new Set();
    const semSite = [];

    for (const el of elementos) {
      const tags = el.tags || {};
      const temSite = tags.website || tags["contact:website"];
      const ehRede = tags.brand || tags["brand:wikidata"];
      const nome = tags.name;

      if (temSite || ehRede || !nome) continue;

      const lat = el.lat || (el.center && el.center.lat);
      const lon = el.lon || (el.center && el.center.lon);
      const chave = `${nome}|${lat}|${lon}`;
      if (vistos.has(chave)) continue;
      vistos.add(chave);

      semSite.push({
        nome,
        endereco: montarEndereco(tags) || "Endereço não cadastrado no OpenStreetMap",
        telefone: tags.phone || tags["contact:phone"] || null,
        instagram: tags["contact:instagram"] || null,
        horario: tags.opening_hours || null,
        nota: null, // OSM não tem sistema de avaliações
        avaliacoes: 0,
      });
    }

    if (elementos.length === 0) {
      console.warn(
        `Nenhum resultado para cidade="${cidade}" nicho="${nicho}". ` +
        `Pode ser que a cidade não tenha esse contorno cadastrado no OSM, ou não haja estabelecimentos desse nicho mapeados ali.`
      );
    }

    res.json({ total: semSite.length, resultados: semSite });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao consultar o OpenStreetMap.", detalhe: err.message });
  }
});

// ADMIN: gera uma chave nova, sem dono ainda, pronta pra ser vendida.
// Pode ser chamada quantas vezes você quiser — não tem limite de geração.
app.post("/api/admin/gerar-chave", exigirLogin, exigirAdmin, async (req, res) => {
  try {
    const { planoId } = req.body;
    if (!planoId) return res.status(400).json({ erro: "Informe planoId." });

    const { data: plano, error: erroPlano } = await supabaseAdmin
      .from("planos").select("*").eq("id", planoId).single();
    if (erroPlano || !plano) return res.status(400).json({ erro: "Plano não encontrado." });

    let codigo;
    let tentativas = 0;
    // Gera até conseguir um código que ainda não existe (chance de colisão é bem baixa)
    while (true) {
      codigo = gerarCodigoChave();
      const { data: existente } = await supabaseAdmin.from("chaves_acesso").select("id").eq("codigo", codigo).maybeSingle();
      if (!existente) break;
      if (++tentativas > 5) return res.status(500).json({ erro: "Não foi possível gerar um código único, tenta de novo." });
    }

    const { data: novaChave, error: erroInsert } = await supabaseAdmin
      .from("chaves_acesso")
      .insert({ codigo, plano_id: planoId, status: "nao_ativada", gerada_por_admin_id: req.usuario.id })
      .select()
      .single();

    if (erroInsert) throw erroInsert;

    res.json({ chave: novaChave, plano });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao gerar chave.", detalhe: err.message });
  }
});

// ADMIN: lista todas as chaves já geradas, pra você acompanhar o que já vendeu.
app.get("/api/admin/chaves", exigirLogin, exigirAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("chaves_acesso")
      .select("*, planos(nome, periodo_dias), perfis!chaves_acesso_usuario_id_fkey(nome, email)")
      .order("data_criacao", { ascending: false });
    if (error) throw error;
    res.json({ chaves: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao listar chaves.", detalhe: err.message });
  }
});

// QUALQUER USUÁRIO LOGADO: ativa uma chave que recebeu depois de comprar.
app.post("/api/ativar-chave", exigirLogin, async (req, res) => {
  try {
    const { codigo } = req.body;
    if (!codigo) return res.status(400).json({ erro: "Informe o código da chave." });

    const { data: chave, error: erroBusca } = await supabaseAdmin
      .from("chaves_acesso")
      .select("*, planos(periodo_dias)")
      .eq("codigo", codigo.trim().toUpperCase())
      .maybeSingle();

    if (erroBusca) throw erroBusca;
    if (!chave) return res.status(404).json({ erro: "Chave não encontrada. Confere se digitou certinho." });

    if (chave.usuario_id && chave.usuario_id !== req.usuario.id) {
      return res.status(409).json({ erro: "Essa chave já está vinculada a outra conta." });
    }
    if (chave.status === "bloqueada") return res.status(403).json({ erro: "Essa chave foi bloqueada." });
    if (chave.status === "cancelada") return res.status(403).json({ erro: "Essa chave foi cancelada." });
    if (chave.status === "expirada") return res.status(403).json({ erro: "Essa chave já expirou." });

    if (chave.status === "ativa" && chave.usuario_id === req.usuario.id) {
      return res.json({ mensagem: "Essa chave já está ativa na sua conta.", chave });
    }

    const agora = new Date();
    const expiracao = new Date(agora.getTime() + chave.planos.periodo_dias * 24 * 60 * 60 * 1000);

    const { data: chaveAtivada, error: erroUpdate } = await supabaseAdmin
      .from("chaves_acesso")
      .update({
        usuario_id: req.usuario.id,
        status: "ativa",
        ativada_em: agora.toISOString(),
        data_expiracao: expiracao.toISOString(),
        dispositivo_ativacao: req.headers["user-agent"] || null,
      })
      .eq("id", chave.id)
      .select()
      .single();

    if (erroUpdate) throw erroUpdate;

    res.json({ mensagem: "Chave ativada com sucesso!", chave: chaveAtivada });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao ativar chave.", detalhe: err.message });
  }
});

const PORTA = process.env.PORT || 3001;
app.listen(PORTA, () => {
  console.log(`Servidor rodando em http://localhost:${PORTA}`);
});
