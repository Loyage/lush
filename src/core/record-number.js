/** Display labels only; database IDs, protocol fields and historical text stay unchanged. */
export const inputNumber = inputId => `O${inputId}`;

/** Only explicit decision kinds qualify for D; never infer semantics from title or status. */
export const noticeNumber = notice => `${['question', 'questionnaire', 'plan'].includes(notice?.kind) ? 'D' : 'N'}${notice?.id ?? '?'}`;
