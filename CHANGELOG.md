# Changelog

Toutes les modifications notables d'OmniDoc sont consignées ici.
Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), versionnage [SemVer](https://semver.org/lang/fr/).

## [Non publié]

## [0.1.1] - 2026-10-16

### Ajouté

- Mises à jour : vérification automatique au démarrage (seulement si vous l'acceptez au premier lancement) ou
  manuelle (palette, Préférences → Mises à jour), notes de version affichées avant l'installation, installation et
  redémarrage en un clic, « Ignorer cette version ».
- « Nouveautés » affichées après une mise à jour ; commande « Notes de version » consultable hors ligne.
- Fermeture de la fenêtre : bouton « Tout enregistrer et quitter ».
- Fichiers à fins de ligne mixtes : choix LF / CRLF / CR à l'enregistrement au lieu d'une normalisation silencieuse.

### Corrigé

- Tableur : une saisie en cours sur une autre feuille que la première pouvait être enregistrée dans la feuille 1.
- PDF : le contenu des pages supprimées, extraites ou découpées pouvait rester dans le fichier via des liens internes.
- Archives : les réécritures (ajout, suppression, renommage) ne perdent plus les entrées aux chemins atypiques, FIFO
  et périphériques ; gz multi-membres lus en entier ; remplacer un dossier retire ses anciens fichiers.
- Enregistrer un fichier qui est un lien symbolique écrit la cible au lieu de remplacer le lien.
- Sauvegardes d'origine : plus de collision entre deux fichiers de même nom enregistrés dans la même seconde.
- Modification externe : avertissement avant d'écraser, détection même juste après un enregistrement.
- Récupération après plantage : plus de perte si le fichier est rouvert au démarrage ; plus d'entrée fantôme.
- Onglet marqué propre à tort quand on tape pendant un enregistrement ou après une restauration.
- Recharger depuis le disque demande confirmation s'il y a des modifications.
- Média : la lecture s'arrête quand on change d'onglet ; une 2e modification de tags est bien détectée.
- Image : Ctrl+S sur un format non enregistrable propose « Enregistrer sous » ; images animées refusées
  explicitement au lieu de perdre l'animation ; profil couleur JPEG conservé ; plafond de 100 Mpx.
- PDF : « Enregistrer sous » avec annotations ouvre le fichier annoté ; zoom Ctrl+= fonctionnel.
- Entrée d'archive ouverte : lecture seule explicite (les modifications n'iraient pas dans l'archive).
- CSV : décodage sans perte, lignes vides conservées, en-tête synchronisé. ODS : références de colonnes et lignes
  entières (`A:A`, `1:1`) converties.
- Calendrier/contacts : sauts de ligne échappés, vCard 2.1 quoted-printable multiligne lisible.
- XLSX, DOCX, ODT : avertissement de perte pour formats numériques, feuilles masquées, mise en page, styles.
- Sécurité : ffmpeg limité aux fichiers locaux (pas de playlist réseau), chemins des conversions externes
  vérifiés, accès aux médias restreint aux fichiers réguliers.
- Raccourcis : Alt+lettre sur macOS, conflits avec les raccourcis d'éditeurs signalés, palette ouverte prioritaire ;
  dialogues destructifs avec le focus sur « Annuler ».
- Messages d'erreur plus précis (encodage, valeur invalide, erreur interne).

## [0.1.0] - 2026-10-16

### Ajouté

- Éditeur de bureau universel : 13 éditeurs et une trentaine de formats (texte et code, Markdown, documents riches
  docx/odt/html, tableurs, images, PDF, archives, audio/vidéo, bases SQLite, calendriers, contacts, notebooks,
  livres, diapositives, hexadécimal en repli).
- Fonctionne hors ligne, sans télémétrie ; réseau uniquement sur action explicite.
- Écriture atomique avec sauvegarde de l'original ; format non supporté en écriture ouvert en lecture seule.
- Interface en français et en anglais, thèmes clair et sombre, palette de commandes, raccourcis personnalisables.
- Récupération automatique après plantage, détection des modifications externes, export vers d'autres formats
  (LibreOffice et pandoc si présents).
