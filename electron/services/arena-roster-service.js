// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

// Mode salle — fournisseur de ROSTERS pour la phase 2 (fuzzy match killfeed).
//
// ⚠️ MOCK TEMPORAIRE : renvoie un roster fixe pour valider la chaîne complète
// en dev. À remplacer par l'appel à l'API locale EVA (réservations /
// participants) découverte sur place — seule cette fonction change, le
// contrat reste : (fileName, meta) => { orangePlayers, bluePlayers } | null.
// `null` = rosters inconnus → l'analyse tourne sans (kills vides, noRosters).

/**
 * @param {string} fileName  Nom du fichier de game ({roomId}_{arenaId}_...).
 * @param {{mode:number, map:string, startSeconds:number, endSeconds:number}} meta
 *   Sidecar de la game (le start epoch du nom permettra, avec l'API réelle,
 *   de retrouver le créneau de réservation correspondant).
 * @returns {Promise<{orangePlayers: {name:string,K:number,D:number}[], bluePlayers: {name:string,K:number,D:number}[]}|null>}
 */
async function getRosters(fileName, meta) {
    const TO_PLAYER = (name) => ({ name, K: 0, D: 0 });
    return {
        orangePlayers: [
            'AWKxK3rEs99',
            'AWKxPingWin',
            'AWKxSha',
            'AWKxAntares'
        ].map(TO_PLAYER),
        bluePlayers: ['EGLxKED', 'rhona', 'EGLXTjafaas', 'EGLXRudeBoy'].map(
            TO_PLAYER
        )
    };
}

module.exports = { getRosters };
