/** review candidate read models and user approval actions. */
export const handlers = {
  'candidate.list'(p, params, actor) { return p.candidates(params.input ?? null); },
  'candidate.inspect'(p, params, actor) { return p.candidate(params.id); },
  'candidate.prepare'(p, params, actor) { return p.prepareCandidate(params.input, params.summary ?? null); },
  'candidate.verify'(p, params, actor) { return p.verifyCandidate(params.id); },
  'candidate.accept'(p, params, actor) { return p.acceptCandidate(params.id); },
  'candidate.changes'(p, params, actor) { return p.requestCandidateChanges(params.id, params.feedback); },
  'candidate.reject'(p, params, actor) { return p.rejectCandidate(params.id, params.reason ?? '用户放弃这版结果'); },
};
