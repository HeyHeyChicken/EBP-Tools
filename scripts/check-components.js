// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

/**
 * Vérifie que chaque composant du manifeste a une entrée pour la plateforme
 * qu'on est en train de construire.
 *
 * Sans ce contrôle, une plateforme oubliée produit une application qui ne
 * démarre pas DU TOUT : `getComponentPath` lève au chargement de constants.js,
 * donc avant la moindre fenêtre. L'échec doit donc survenir ici, dans le CI,
 * plutôt que chez l'utilisateur.
 *
 * Usage : node scripts/check-components.js <clé-de-plateforme>
 *   clés : darwin-arm64 | darwin-x64 | win32 | linux
 */
const COMPONENTS = require('../electron/config/components.json');

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

console.log(`Tous les composants (${Object.keys(COMPONENTS).join(', ')}) ont une entrée pour ${KEY}.`);
