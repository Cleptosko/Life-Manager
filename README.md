# 🌿 Life Manager

Application de gestion personnelle tout-en-un : **tableau de bord** avec actualités,
**Agenda**, **Emploi du temps** (avec export Excel/PDF), **To-Do List**, **Météo**,
**YouTube** (tendances, recherche, dashboard de chaîne), **Projets** (kanban, journal
d'avancement) et **Coffre de mots de passe** chiffré (AES-256-GCM + PBKDF2).

Couleur principale : vert `#03fc49`, avec une couleur par onglet. Thème clair/sombre.
Données 100 % locales et chiffrées : rien n'est envoyé sur un serveur.

---

## 📥 Téléchargement

Deux versions sont disponibles dans la section **[Releases](https://github.com/Cleptosko/Life-Manager/releases)** :

| Version | Fichier | Pour qui |
|---|---|---|
| 🖥️ **Application Windows** | `Life-Manager-Setup-1.0.0.exe` | Tout le monde — installer classique (choix du dossier, raccourci bureau, icône) |
| 🌐 **Version web (code source)** | `life-manager-web.zip` | Les développeurs qui veulent ouvrir, modifier ou améliorer l'application |

### 🖥️ Version exe (recommandée)

1. Télécharge `Life-Manager-Setup-1.0.0.exe` depuis les [Releases](https://github.com/Cleptosko/Life-Manager/releases).
2. Lance l'installateur, choisis le dossier d'installation, puis l'app se lance.
3. Au premier démarrage : choisis ton nom et un mot de passe (il protège tes données).
4. Tes données sont **conservées** d'une session à l'autre (stockées dans `%APPDATA%\Life Manager`).
5. La taille et la position de la fenêtre sont mémorisées.

> ℹ️ Windows peut afficher « Éditeur inconnu » au premier lancement (l'app n'est pas signée
> commercialement). Clique sur « Plus d'infos » → « Exécuter quand même ».

### 🌐 Version web (code source)

Télécharge `life-manager-web.zip`, décompresse, puis :

```bash
# Option 1 : serveur statique simple (recommandé)
python -m http.server 8080
# puis ouvre http://localhost:8080

# Option 2 : n'importe quel serveur statique (VS Code Live Server, etc.)
```

> ⚠️ Pour le bon fonctionnement complet (API YouTube, géolocalisation, actualités),
> sert le dossier via un serveur HTTP local plutôt que d'ouvrir `index.html` en direct.

---

## 🔑 Clé API YouTube (optionnelle)

L'onglet YouTube utilise l'**API YouTube Data v3** (lecture seule, gratuite) :

1. Va sur <https://console.cloud.google.com/apis/library/youtube.googleapis.com> et active l'API.
2. **Identifiants** → **Créer des identifiants** → **Clé API**.
3. Colle la clé dans l'onglet YouTube de l'application (bouton ❓ Aide pour le détail).

Sans clé, les onglets Tendances/Recherche/Chaîne ne fonctionneront pas ; le reste de l'app est indépendant.

---

## 🛠 Développer

Le code source est organisé en deux dossiers :

```
Life Manager/     ← l'application web (HTML/CSS/JS purs, aucune dépendance)
desktop/          ← le wrapper Electron (transforme la web en .exe)
```

### Version web

Aucune dépendance à installer : tout est en HTML/CSS/JS natif. Ouvre avec un serveur statique.

### Version exe (Electron)

```bash
cd desktop
npm install
npm start          # lance l'app en développement
npm run dist       # génère l'installateur NSIS dans dist/
```

---

## 🔐 Sécurité

- **Chiffrement** : toutes les données sont chiffrées en AES-256-GCM, clé dérivée du
  mot de passe via PBKDF2 (600 000 itérations).
- **Coffre de mots de passe** : protégé par un mot de passe fort (12 caractères min,
  majuscule/minuscule/chiffre/symbole, sans mot du dictionnaire).
- **Stockage 100 % local** : `localStorage` (navigateur) ou `%APPDATA%` (exe).
- Sans le mot de passe, les données sont **irrécupérables** (clé jamais stockée).

---

## 📄 Licence

MIT — libre d'utilisation, de modification et de redistribution.
