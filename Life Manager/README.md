# 🌿 Life Manager

Application web d'organisation personnelle : tableau de bord (avec **actualités**),
**Agenda** (événements datés, vues Jour / Semaine / Mois / Année),
**Emploi du temps** (planning hebdomadaire en grille, sans dates — le « mode scolaire »,
exports **Excel** et **PDF**), **To-Do List** (priorités + date limite + tri automatique),
**Météo** (Open-Meteo), **YouTube** (recherche, tendances, stats de vidéos) et
**Projets** (statut, priorité, échéance, couleurs, étiquettes, **kanban** avec glisser-déposer,
journal d'avancement, filtres, export CSV).

Couleur principale : vert `#03fc49`, avec une couleur par onglet
(vert = tableau de bord, bleu = agenda, violet = emploi du temps,
jaune = to-do, cyan = météo, rouge = YouTube). Thème **clair / sombre**
commutable à tout moment. Hébergement prévu : **GitHub Pages**.

## Onglet YouTube — clé API

L'onglet YouTube utilise l'**API YouTube Data v3** avec une simple clé API
(lecture seule, sans connexion à un compte) :

1. Va sur <https://console.cloud.google.com/apis/library/youtube.googleapis.com>
   et active l'API « YouTube Data API v3 » (compte Google, gratuit).
2. Dans **Identifiants (Credentials)** → **Créer des identifiants** → **Clé API**,
   copie la clé générée.
3. Colle-la dans l'onglet YouTube de l'application (champ « Clé API YouTube »)
   puis clique sur **Enregistrer la clé**. Elle est stockée localement dans ton
   navigateur.

Fonctionnalités (dans l'ordre des onglets : **Tendances France** en premier,
puis **Recherche**, puis **Ma chaîne**) :

- **🔥 Tendances France** : top 24 des vidéos populaires, avec un **filtre de
  catégorie prédéfini** (Jeux vidéo, Musique, Divertissement, Sport, Actualités,
  Sciences & Tech, Éducation, Films, People & Blogs, Comédie) au lieu d'une
  recherche libre.
- **🔍 Recherche** : résultats en français, 24 vidéos.
- **📺 Ma chaîne** : dashboard de chaîne (voir ci-dessous).

Le bouton **❓ Aide** en haut de la page ouvre un guide détaillé (avec liens)
pour mettre en place la clé API YouTube (seule la clé est nécessaire).
Chaque vidéo s'ouvre dans une fiche avec **grande miniature cliquable** (vues,
likes, commentaires, durée, date) qui lance la vidéo sur YouTube dans un nouvel
onglet.

### Dashboard de chaîne (📺 Ma chaîne)

1. Entre le **@handle** (ex. `@monchaine`) ou l'**ID** de la chaîne dans le champ
   « Handle ou ID de chaîne… » puis clique sur **Enregistrer la chaîne**
   (stocké localement, comme la clé).
2. Ouvre l'onglet **📺 Ma chaîne** : bannière, avatar, abonnés / vues totales /
   nombre de vidéos, **vues et likes récents** (24 dernières vidéos), un
   **graphique** des vues des dernières vidéos et un **tableau** des 24 dernières
   vidéos (vignette, vues, likes, durée, date — cliquable → fiche vidéo).

N'importe quelle chaîne publique peut être suivie — pas seulement la tienne.

Au **tableau de bord**, un mini récap affiche le nom de la chaîne et son
**nombre exact d'abonnés** (sans arrondi), mis à jour dès que tu charges
« 📺 Ma chaîne ».

## Actualités (tableau de bord)

La colonne de droite du tableau de bord affiche les **actualités françaises**
en **2 colonnes avec vignette** (titre au-dessus de l'image) à partir de
**flux RSS directs** de médias français : France Info (À la une), Numerama
(Technologie), Le Monde (Sport / Santé / Science), Jeuxvideo.com (Jeux vidéo).
Récupérés par l'API rss2json (CORS natif) avec repli sur un proxy CORS public.
Résultats mis en cache 30 minutes (bouton ↻ pour actualiser). Aucune clé requise.

## Technologies

- HTML / CSS / JavaScript (aucun build nécessaire)
- [Supabase](https://supabase.com) pour l'authentification et les données
  (chargé via CDN)

## 1. Créer le projet Supabase (gratuit)

1. Va sur <https://supabase.com> et crée un compte.
2. Crée un nouveau projet (n'importe quel nom, ex. `life-manager`).
3. Dans **Settings > API**, copie :
   - l'**URL** du projet ;
   - la clé **anon / public**.
4. Colle-les dans le fichier `supabase-config.js`.

> Pour tester sans recevoir d'email de confirmation :
> **Authentication > Providers > Email** → désactive
> *« Confirm email »*. (Pour la production, laisse-le activé.)

## 2. Créer les tables (SQL)

Dans Supabase : **SQL Editor** → colle et exécute le script ci-dessous.

```sql
-- Événements (agenda : dates réelles)
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  start_at timestamptz not null,
  end_at timestamptz,
  all_day boolean not null default false,
  created_at timestamptz not null default now()
);

-- Tâches (to-do)
create table if not exists public.todos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  done boolean not null default false,
  priority text not null default 'medium',
  created_at timestamptz not null default now()
);

-- Sécurité : chaque utilisateur ne voit que ses propres données
alter table public.events enable row level security;
alter table public.todos enable row level security;

create policy "events_own" on public.events
  for all using (auth.uid() = user_id);

create policy "todos_own" on public.todos
  for all using (auth.uid() = user_id);

-- Activités récurrentes de l'emploi du temps (une semaine type, sans date)
create table if not exists public.timetable_activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text not null default '',
  day_of_week int not null,          -- 0 = Lundi ... 6 = Dimanche
  start_time time not null,
  end_time time not null,
  created_at timestamptz not null default now()
);

-- Annulations ponctuelles, liées à une semaine précise
create table if not exists public.timetable_cancellations (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.timetable_activities(id) on delete cascade,
  week_start date not null,          -- lundi de la semaine concernée
  created_at timestamptz not null default now(),
  unique (activity_id, week_start)
);

alter table public.timetable_activities enable row level security;
alter table public.timetable_cancellations enable row level security;

create policy "tt_activities_own" on public.timetable_activities
  for all using (auth.uid() = user_id);

create policy "tt_cancellations_own" on public.timetable_cancellations
  for all using (exists (
    select 1 from public.timetable_activities a
    where a.id = timetable_cancellations.activity_id
    and a.user_id = auth.uid()
  ));
```

### Nouveau : réglages de l'emploi du temps (découpage 30/60 min)

Si tu as déjà exécuté le script précédent, exécute **ce bloc séparément**
(il est protégé : il peut être relancé sans erreur) :

```sql
-- Réglages de l'emploi du temps (découpage horaire, synchronisé)
create table if not exists public.timetable_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  slot_min int not null default 60,   -- 30 ou 60 minutes par case
  created_at timestamptz not null default now()
);

alter table public.timetable_settings enable row level security;

drop policy if exists "tt_settings_own" on public.timetable_settings;
create policy "tt_settings_own" on public.timetable_settings
  for all using (auth.uid() = user_id);
```

### Nouveau : date limite des tâches (To-Do)

Si ta table `todos` vient du premier script, ajoute la colonne **date limite**
en exécutant ce bloc (réexécutable sans erreur) :

```sql
-- Ajoute une date limite optionnelle aux tâches
alter table public.todos add column if not exists due_date date;
```

## Fonctionnalités de l'emploi du temps

- Grille **Lundi → Dimanche × 07:00 → 22:00**, découpée en cases de **30 ou
  60 minutes** (choix à la création, modifiable ensuite en mode édition,
  sauvegardé dans Supabase).
- **Jusqu'à 3 activités par case**, affichées côte à côte avec une couleur
  automatique (6 teintes, lisibles en clair et en sombre).
- **Mode lecture** : consultation seule + annulation/réactivation d'une
  activité pour la semaine. **Mode édition** : bannière visible, cases
  cliquables, ajout / modification / suppression.
- Les activités annulées pour la semaine sont grisées et barrées, puis
  réapparaissent automatiquement la semaine suivante.

## 3. Héberger sur GitHub Pages

1. Crée un dépôt GitHub (ex. `life-manager`) et pousse ces fichiers :
   `index.html`, `style.css`, `app.js`, `supabase-config.js`, `README.md`.
2. Dans le dépôt : **Settings > Pages** → Source : `main` (ou `master`), dossier `/ (root)` → Enregistrer.
3. Le site sera disponible sur :
   `https://TON-USERNAME.github.io/life-manager/`



## Onglet Projets

- **Champs** : statut (À faire / En cours / Terminé / En pause), priorité,
  date limite, couleur, étiquettes.
- **Kanban** : colonnes À faire / En cours / Terminé, glisser-déposer des tâches,
  ajout direct dans une colonne, priorité et date limite par tâche.
- **Journal d'avancement** : notes datées en fil chronologique.
- **Recherche, filtres et tri** : par texte, statut, priorité ; tri par échéance,
  progression, priorité, nom ou création.
- **Export CSV** : projets + tâches (compatible Excel FR, séparateur `;`).
- Le tableau de bord affiche les **projets en cours** avec leur progression.

## Export de l'emploi du temps

Trois boutons en haut de l'onglet Emploi du temps :

- **🖨 Imprimer** : impression navigateur (aperçu PDF), grille corrigée.
- **📊 Excel** : fichier `.xlsx` généré avec SheetJS (grille Créneau × Jour + feuille
  « Liste » détaillée). La librairie est chargée à la demande depuis le CDN.
- **📄 PDF** : fichier `.pdf` généré avec jsPDF (A4 paysage, couleurs par activité,
  activités annulées grisées).

> Ne commite jamais ta clé **service_role** (secrète). La clé `anon` publique
> est la seule à mettre dans `supabase-config.js`.
