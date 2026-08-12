// server/age.mjs: age is a PARAMETER, not a branch.
//
// Revision 1 of this project used git branches for age (age-5, main, age-12).
// That was a config switch wearing a git costume: the branches differed by one
// file and never diverged, so nothing about git was doing any work. Branches
// now carry the thing that genuinely diverges, which is per-child learning,
// and age is passed where it is actually needed: into the tutor's voice for
// this session, and into the judge's target derivation.

/**
 * Snap any typed age to a band, with a warm confirmation to show the child.
 * Never silent: silent snapping reads as a bug.
 */
export function ageProfile(rawAge) {
  const age = Math.round(Number(rawAge));
  if (!Number.isFinite(age)) return { age: 8, band: "middle", note: null, voice: VOICE.middle };

  // "an 8 year old", not "a 8 year old": 8, 11 and 18 take "an".
  const a = /^(8|11|18)/.test(String(age)) ? "an" : "a";

  if (age <= 6) {
    return {
      age, band: "young", voice: VOICE.young,
      note: age < 4
        ? `Whyzr is built for kids from about 4 up. For ${a} ${age} year old, sit together and explore as a pair.`
        : `Got it. Whyzr will talk like a friend for ${a} ${age} year old.`,
    };
  }
  if (age <= 10) {
    return { age, band: "middle", voice: VOICE.middle, note: `Got it. Whyzr will talk like a friend for ${a} ${age} year old.` };
  }
  if (age <= 14) {
    return { age, band: "older", voice: VOICE.older, note: `Got it. Whyzr will talk like a lab partner for ${a} ${age} year old.` };
  }
  return {
    age, band: "older", voice: VOICE.older,
    note: "Whyzr is built for kids up to about 14, but you are welcome to try. Using the oldest setting.",
  };
}

// The voice guidance that used to live in three separate SOUL.md files on
// three branches. Same content, delivered as a per-session parameter.
const VOICE = {
  young: `The child is very young (about 4 to 6). A grown-up is probably helping
them read and type.
- Five to eight words per sentence. Only small words.
- No technical terms at all, not even explained ones. Say "the water goes up
  into the air", never "evaporation".
- One rung per ladder. Questions must be answerable by looking, touching, or
  remembering something from their own small world.
- Sound effects and play are welcome. Celebrate every brave guess.`,

  middle: `The child is about 7 to 10. They read short sentences and know school
basics: simple arithmetic, animals, weather, how things look and feel.
- Short sentences, one idea each.
- Words they know. A bigger word is fine if you explain it in the same breath.
- Ladders of two or three rungs.
- Genuine, sparing excitement when they earn it, not every turn.`,

  older: `The child is about 11 to 14. Never talk down to them; they can smell a
babyish tone instantly and it ends the conversation.
- Normal sentences. Real vocabulary is welcome: introduce the proper term once
  they have built the idea themselves.
- Ladders of four to six rungs. They can hold more than one idea at a time.
- Push toward evidence: what would you measure, what would change your mind.
- Let them defend a wrong idea for a while. Being argued out of something by
  evidence is the best lesson at this age.`,
};

/** The system-prompt fragment for a session with this child. */
export function voiceSuffix(profile) {
  return `\n\n## This child\n\nThis child is ${profile.age} years old.\n\n${profile.voice}`;
}
