-- Per-session QA share — the third consent surface.
--
-- The two-tier opt-in (0001) is ambient: a standing agreement covering future
-- sessions. This table serves the opposite gesture — a player, at the end of
-- one run, explicitly handing that run to QA. It works for players who
-- declined ambient collection entirely, which matters: the player who opted
-- out is exactly the player whose bug reports we otherwise never see.
--
-- One row per shared session. The note is free text by design — it is the
-- player's message TO the QA team, written in the knowledge it will be read.
-- The transcript itself rides the existing `transcripts` table for the same
-- session id; the share path forces that tier on for the one approved run.

create table if not exists public.feedback (
  session_id  uuid        primary key references public.sessions(id) on delete cascade,
  -- What the player wanted QA to know. Empty when they shared without comment.
  note        text        not null default '',
  -- Which build the report is about — the first filter on any bug queue.
  build       text        not null,
  -- Set server-side. A client clock is not evidence.
  received_at timestamptz not null default now()
);

comment on table public.feedback is
  'Runs a player explicitly handed to QA at end of game, with their note. '
  'Consent is per-session and independent of the ambient telemetry tiers.';

-- Same rule as 0001: the client writes and cannot read.
alter table public.feedback enable row level security;

drop policy if exists feedback_insert on public.feedback;
create policy feedback_insert on public.feedback for insert to anon with check (true);

-- Deliberately no select/update/delete for `anon` — their absence is the
-- security property. The reference id shown to the player after sharing is
-- their deletion handle: quoting it to support is how a shared run is removed,
-- via the service role, never via the shipped key.
