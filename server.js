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

const app = express();
app.use(cors());
app.use(express.json());

const USER_AGENT = "achou-site-prototipo (contato@example.com)";

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

const PORTA = process.env.PORT || 3001;
app.listen(PORTA, () => {
  console.log(`Servidor rodando em http://localhost:${PORTA}`);
});
