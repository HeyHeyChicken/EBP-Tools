// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

/**
 * Vérifie deux choses avant de construire une release :
 *   1. chaque composant du manifeste a une entrée pour la plateforme construite ;
 *   2. le binaire publié correspond encore à la source dont il est issu.
 *
 * Sans ce contrôle, une plateforme oubliée produit une application qui ne
 * démarre pas DU TOUT : `getComponentPath` lève au chargement de constants.js,
 * donc avant la moindre fenêtre. L'échec doit donc survenir ici, dans le CI,
 * plutôt que chez l'utilisateur.
 *
 * Usage : node scripts/check-components.js <clé-de-plateforme>
 *   clés : darwin-arm64 | darwin-x64 | win32 | linux
 */
const { execSync } = require('child_process');
const COMPONENTS = require('../electron/config/components.json');

/**
 * État de la source de l'analyzer, tel que git le connaît. L'empreinte de
 * l'arbre du dossier `python/` change dès qu'un fichier suivi change, et ne
 * change pas autrement — c'est exactement la question posée.
 * @returns {string} Tree hash, tronqué comme dans le manifeste.
 */
function pythonSource() {
    return execSync('git rev-parse HEAD:python', { encoding: 'utf8' })
        .trim()
        .slice(0, 12);
}

const KEY = process.argv[2];
if (!KEY) {
    console.error('Usage: node scripts/check-components.js <platform-key>');
    process.exit(1);
}

const MISSING = Object.keys(COMPONENTS).filter((name) => !COMPONENTS[name][KEY]);

if (MISSING.length > 0) {
    console.error(
        `::error::Aucun composant publié pour ${KEY} : ${MISSING.join(', ')}. ` +
            'Publier via le workflow "Publish analyzer component", puis reporter ' +
            "l'entrée affichée dans electron/config/components.json."
    );
    process.exit(1);
}

// Deuxième contrôle : le binaire publié correspond-il encore au code ?
// Sans lui, modifier du Python puis taguer une release livre silencieusement
// l'ancien analyzer — les utilisateurs n'obtiennent pas le correctif, et rien
// ne le signale nulle part.
const SOURCE = pythonSource();
const STALE = Object.keys(COMPONENTS)
    .map((name) => [name, COMPONENTS[name][KEY]])
    .filter(([, entry]) => entry.source && entry.source !== SOURCE);

if (STALE.length > 0) {
    for (const [name, entry] of STALE) {
        console.error(
            `::error::Le composant "${name}" a été publié depuis la source ${entry.source}, ` +
                `or python/ est aujourd'hui à ${SOURCE}. Republier via le workflow ` +
                '"Publish analyzer component" et reporter la nouvelle entrée, ' +
                'ou revenir sur les modifications de python/.'
        );
    }
    process.exit(1);
}

console.log(
    `Tous les composants (${Object.keys(COMPONENTS).join(', ')}) ont une entrée pour ${KEY}, ` +
        `et leur source correspond à python/ (${SOURCE}).`
);
