# Backend achou.site (versão OpenStreetMap)

Serve o endpoint `GET /api/buscar?cidade=Campinas, SP&nicho=barbearia`.

Usa duas APIs públicas e **totalmente gratuitas**, sem chave, sem cadastro e
sem cartão de crédito:

- **Nominatim** — encontra a cidade e sua área administrativa
- **Overpass API** — busca estabelecimentos dentro dessa área, filtrando por
  tipo de negócio e ausência do campo `website`

## Como rodar

1. Instale as dependências:
   ```
   npm install
   ```
2. Rode o servidor:
   ```
   npm run dev
   ```
3. Teste:
   ```
   curl "http://localhost:3001/api/buscar?cidade=Campinas,%20SP&nicho=barbearia"
   ```

Não precisa criar nada em nenhum site antes de rodar. É só instalar e usar.

## Limitações importantes (por ser dado colaborativo)

- **Cobertura variável**: o OpenStreetMap é mantido por voluntários. Cidades
  grandes (São Paulo, Campinas, Ribeirão Preto) costumam ter bom cadastro;
  cidades pequenas podem ter poucos estabelecimentos marcados.
- **Sem nota/avaliações**: o OSM não tem sistema de reviews como o Google.
  O campo `nota` sempre vem `null`.
- **Telefone e Instagram nem sempre estão preenchidos**: dependem de quem
  cadastrou o local no mapa.
- **"Sem site" pode significar "não cadastrado"**, não necessariamente que o
  estabelecimento não tenha site de verdade — vale conferir manualmente antes
  de abordar o dono do negócio.

## Respeite os limites de uso

- **Nominatim**: no máximo 1 requisição por segundo, e é obrigatório enviar
  um `User-Agent` identificável (já está configurado no código).
- **Overpass API**: é um serviço mantido por voluntários também — evite fazer
  buscas em massa. Para uso mais pesado, existem instâncias alternativas
  (ex: overpass.kumi.systems) ou você pode rodar sua própria instância.

## Se quiser subir de nível depois

- Adicionar uma segunda fonte de dados (ex: Google Places, quando quiser
  pagar) e combinar os dois resultados.
- Cachear os resultados por cidade/nicho por algumas horas, pra não bater
  toda vez nas APIs públicas.
- Buscar Instagram separadamente quando o OSM não tiver esse dado.
