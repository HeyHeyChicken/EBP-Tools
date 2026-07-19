# Arena mode — API contract (contract-first)

Mode « salle » : Tools tourne sur le PC de streaming d'une salle EVA, enregistre
en continu, borne les games par détection de frames (loading → score), les
analyse puis les uploade en qualité originale sur le S3 d'EBP dans un dossier
d'attente. À l'import EVA d'un joueur, le backend matche la game pré-enregistrée
(salle + arène + map + fenêtre temporelle + scores) et la bascule en permanent :
vidéo et analyse instantanées côté client.

Côté Tools, le mode est actif par-dessus une session user EBP classique (cookie
`auth`) : tous les endpoints ci-dessous exigent le cookie user **et**, après
enregistrement, le token d'arène.

## 1. Enregistrement de l'arène — IMPLÉMENTÉ (EBP-Site tools.api.ts)

`POST /api/tools/arena/register`

Auth : cookie `auth` (user connecté). Rate-limité (5/min).

```json
{ "roomId": 123, "arenaId": 1, "key": "<clé fournie à la salle>" }
```

- `roomId` : id de la salle = `T_EVA_Locations.id`.
- `arenaId` : id de l'arène = `T_EVA_Terrains.id` (doit appartenir à la salle).
  Les deux ids sont affichés sur la page admin « Tools - salles » et fournis à
  la salle avec la clé.
- `key` : clé secrète de la salle = colonne `T_EVA_Locations.tools_token`
  (NULL = mode salle désactivé pour cette salle). Révocation = changer/vider
  la colonne. Si `T_EVA_Locations.tools_ip` est renseignée, la requête doit en
  plus venir de cette IP (première IP de `x-forwarded-for`).
- IP en trust-on-first-use : au premier register réussi d'une salle dont
  `tools_ip` est NULL, le serveur y verrouille l'IP d'origine. IP de la salle
  changée → un admin supprime l'IP (page « Tools - salles ») et le prochain
  register re-verrouille. Conflit d'unicité (IP déjà prise) → register OK mais
  IP non verrouillée (loggé).

La clé validée sert elle-même de credential pour les endpoints salle suivants
(header `X-Arena-Token`) — pas de token séparé.

Réponses :

- `200` `{ "roomName": "EVA Lyon", "terrainId": "456", "terrainName": "..." }` —
  `terrainId` = id réel du terrain, stocké par Tools pour le futur matching des
  games (T_Games.terrain_id).
- `401/403` : cookie user absent/expiré (jamais utilisé pour la clé — Tools
  traite 401/403 comme une perte de session).
- `404` : salle inconnue, ou terrain `arenaId` n'appartenant pas à la salle.
- `422` : clé refusée (clé invalide, mode désactivé ou mauvaise IP —
  volontairement indistincts).

Migration SQL à appliquer (contraintes uniques : NULL autorisé en multiple,
mais une clé/IP renseignée ne peut appartenir qu'à une seule salle ; noms de
contraintes alignés sur la convention Prisma) :

```sql
ALTER TABLE T_EVA_Locations
    ADD COLUMN tools_token VARCHAR(200) NULL,
    ADD COLUMN tools_ip VARCHAR(200) NULL,
    ADD UNIQUE KEY T_EVA_Locations_tools_token_key (tools_token),
    ADD UNIQUE KEY T_EVA_Locations_tools_ip_key (tools_ip);
```

## 2. Heartbeat — IMPLÉMENTÉ

`POST /api/tools/arena/heartbeat`

Auth : header `X-Arena-Token` (la clé de salle) UNIQUEMENT — pas de cookie,
le PC salle doit battre même session user expirée. Mêmes vérifications que le
register (clé + IP, TOFU inclus : une IP supprimée par un admin est
re-verrouillée au battement suivant). Rate-limité (10/min).

```json
{ "roomId": 6, "arenaId": 20, "version": "3.1.4" }
```

- `200` `{ "update": boolean }` : battement enregistré →
  `tools_last_seen_at = now()` + `tools_version` stockée (debug à distance,
  affichée sur la page admin). `update: true` = un admin a ordonné la mise à
  jour (bouton page admin quand version ≠ dernière release) : Tools l'exécute
  IMMÉDIATEMENT (stop captation propre → installeur silencieux → relance ;
  cooldown 45 min entre tentatives). Le flag `tools_update_requested` n'est
  pas nettoyé à la livraison mais quand la version remontée change (= install
  réussie) — Tools retente donc tant que ça n'a pas abouti.
- `400/404/422` : comme le register.

Côté Tools : `arena-mode-service.startHeartbeat()` — battement immédiat puis
toutes les 5 min quand le mode salle est actif (au boot de l'app et après un
register). La page admin « Tools - salles » affiche une pastille verte par
arène si le dernier battement a moins de 15 min.

Migration SQL à appliquer :

```sql
ALTER TABLE T_EVA_Terrains ADD COLUMN tools_last_seen_at DATETIME(3) NULL;
-- Version + ordre de MAJ (2026-07-19) :
ALTER TABLE T_EVA_Terrains
    ADD COLUMN tools_version VARCHAR(20) NULL,
    ADD COLUMN tools_update_requested TINYINT(1) NOT NULL DEFAULT 0;
```

## 3. Upload & dépôt d'analyse — IMPLÉMENTÉS

Auth : header `X-Arena-Token` seul (comme le heartbeat, mêmes vérifications
clé + IP). Nom de fichier :
`{roomId}_{arenaId}_{SafeMap}_{startEpoch}_{endEpoch}_{scoreOrange}-{scoreBlue}.mp4`
(epoch UTC secondes ; map sanitizée en tirets ; scores informatifs). La
captation encode web-ready à la source (H.264, GOP 1 s, keyframe/s pour le
seek du lecteur web) : la découpe est un stream-copy/remux mp4 +faststart aux
bornes de la détection (±1 s de marge) — aucun réencodage, aucune perte, CPU
quasi nul sur le PC de salle. Le serveur vérifie que roomId/arenaId du nom =
ceux du token.

- `POST /api/tools/arena/games/upload-url` `{roomId, arenaId, fileName}` →
  `{url, key, expiresAt}` — URL présignée PUT (30 min) vers
  `arena/pending/{roomId}/{arenaId}/{fileName}` (bucket Tools). 400 nom
  invalide/croisé, 404/422 comme register.
- `POST /api/tools/arena/games` `{roomId, arenaId, fileName, payload, noRosters}`
  → upsert `T_Arena_Pending_Games` (idempotent). 412 si la vidéo n'est pas
  encore dans `pending/` (statObject). `payload` = analyse phase 2 (nullable),
  `noRosters` = analyse calculée sans pseudos trustés.

Côté Tools : `arena-uploader-service` consomme `games/` — phase 2 via le
`runChunkAnalyzer` existant (rosters via provider optionnel, à brancher sur
l'API locale EVA), puis upload avec retry persistant (URL fraîche à chaque
tentative, backoff 30 s → 10 min, infini) et dépôt. Fichier + sidecar locaux
supprimés seulement une fois les deux réussis.

Migration SQL à appliquer :

```sql
CREATE TABLE T_Arena_Pending_Games (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    file_name VARCHAR(255) NOT NULL,
    location_id BIGINT NOT NULL,
    terrain_id BIGINT NOT NULL,
    map VARCHAR(100) NOT NULL,
    start_epoch BIGINT NOT NULL,
    end_epoch BIGINT NOT NULL,
    payload LONGTEXT NULL,
    no_rosters TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY T_Arena_Pending_Games_file_name_key (file_name),
    KEY T_Arena_Pending_Games_terrain_id_start_epoch_idx (terrain_id, start_epoch)
);
```

À poser côté infra : règle de lifecycle MinIO 14 jours sur le préfixe
`arena/pending/` du bucket Tools.

Matching à l'import EVA : salle + arène (exacts, fournis par EVA) + map +
fenêtre temporelle (±3 min sur startEpoch). Les scores du nom de fichier sont
INFORMATIFS UNIQUEMENT — l'OCR des score frames est faillible (constaté le
2026-07-18 : 70 lu « 20 » sur Atlantis), ils ne participent jamais au matching.

Rétention : lifecycle S3 de 14 jours sur `pending/` ; à l'import EVA, le back
déplace la vidéo vers le dossier permanent et attache l'analyse à la game.
