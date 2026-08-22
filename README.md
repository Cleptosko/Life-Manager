# 🌿 Life Manager

Application web d'organisation personnelle : tableau de bord, **Agenda**
(événements datés, vues Jour / Semaine / Mois / Année), **Emploi du temps**
(planning hebdomadaire récurrent, sans dates — le « mode scolaire ») et
**To-Do List** (priorités + tri automatique).

Couleur principale : `#03fc49`. Hébergement prévu : **GitHub Pages**.

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

## 3. Héberger sur GitHub Pages

1. Crée un dépôt GitHub (ex. `life-manager`) et pousse ces fichiers :
   `index.html`, `style.css`, `app.js`, `supabase-config.js`, `README.md`.
2. Dans le dépôt : **Settings > Pages** → Source : `main` (ou `master`), dossier `/ (root)` → Enregistrer.
3. Le site sera disponible sur :
   `https://TON-USERNAME.github.io/life-manager/`

> Ne commite jamais ta clé **service_role** (secrète). La clé `anon` publique
> est la seule à mettre dans `supabase-config.js`.
