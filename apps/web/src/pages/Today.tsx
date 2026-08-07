import { useEffect, useState } from 'react';
import { getProfile, type Profile } from '../api.js';

/** Spec §10.1. Placeholder in Stage 1 — the real dashboard needs due counts, which
 *  arrive with cards in Stage 3. */
export function Today() {
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    getProfile().then(setProfile).catch(() => setProfile(null));
  }, []);

  return (
    <section className="panel">
      <h1>Today</h1>
      {profile ? (
        <dl className="kv">
          <dt>Learning</dt>
          <dd>
            {profile.targetLanguage} → {profile.nativeLanguage}
          </dd>
          <dt>Daily target</dt>
          <dd>{profile.dailyMinutes} minutes</dd>
          <dt>New items per day</dt>
          <dd>{profile.newItemLimit}</dd>
        </dl>
      ) : (
        <p>Loading profile…</p>
      )}
      <p className="hint">
        Due counts and the session launcher arrive in Stage 3, once cards exist.
      </p>
    </section>
  );
}
