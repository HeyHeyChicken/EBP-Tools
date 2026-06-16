// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

// Système i18n minimal pour le main process (inspiré du Discord-translation-bot).
// Les JSON sont require()'d statiquement pour que webpack les inline dans le bundle
// (fs.readFileSync(__dirname) ne survit pas au bundling du main process).

const { app } = require('electron');
const StorageManager = require('../core/storage-manager');

const TRANSLATIONS = {
    de: require('../assets/i18n/de.json'),
    en: require('../assets/i18n/en.json'),
    es: require('../assets/i18n/es.json'),
    fr: require('../assets/i18n/fr.json'),
    it: require('../assets/i18n/it.json'),
    pt: require('../assets/i18n/pt.json'),
    ro: require('../assets/i18n/ro.json')
};

const DEFAULT_LANGUAGE = 'en';

/**
 * Langue courante de l'utilisateur, normalisée sur 2 lettres.
 * Priorité : langue choisie dans l'UI, sinon locale système Electron.
 */
function getCurrentLanguage() {
    const RAW =
        StorageManager.permanentSettings['language'] || app.getLocale() || DEFAULT_LANGUAGE;
    const CODE = String(RAW).slice(0, 2).toLowerCase();
    return TRANSLATIONS[CODE] ? CODE : DEFAULT_LANGUAGE;
}

/**
 * Traduit une clé (notation pointée "a.b.c") dans la langue donnée.
 * Interpole les variables {{ nom }}. Fallback : la clé brute si introuvable.
 */
function i18n(language, key, variables) {
    const TABLE = TRANSLATIONS[language] || TRANSLATIONS[DEFAULT_LANGUAGE];

    let value = key.split('.').reduce((o, k) => (o == null ? o : o[k]), TABLE);

    if (typeof value === 'string' && variables) {
        value = value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) =>
            variables[name] != null ? variables[name] : `{{${name}}}`
        );
    }

    return value != null ? value : key;
}

/**
 * Raccourci : traduit dans la langue courante de l'utilisateur.
 */
function t(key, variables) {
    return i18n(getCurrentLanguage(), key, variables);
}

module.exports = { i18n, t, getCurrentLanguage };
