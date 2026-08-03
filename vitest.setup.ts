/**
 * The test suite does not write to anyone's journal.
 *
 * `runSetup` opens one when the caller does not supply it, which is right in a
 * game and wrong in a test: every setup test wrote a real session file into
 * `.bizsim/sessions` in the working directory. One run of `pnpm check` left
 * about forty behind, and they accumulated — 1,284 of them by the time anyone
 * looked, against two real sessions.
 *
 * That is not a tidiness problem. `pnpm sim --sessions` is the corpus the
 * provider comparison is decided from, and it was reporting "1,286 sessions ·
 * 838 committed · $0.00" — a scripted-transport session commits reliably and
 * costs nothing, so the fixtures dominate every rate in the table and drag the
 * cost per committed session toward zero. A measurement instrument that fills
 * itself with its own test output is worse than no instrument.
 *
 * `journal.test.ts` deletes this variable in its own setup, so journaling is
 * still tested — against a temporary directory, which is what it always did.
 */
process.env['BIZSIM_NO_JOURNAL'] = '1';
