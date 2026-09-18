// One message table for every parent-facing channel: USSD now, SMS in story 5.
export type Language = 'sw' | 'en';

export type MessageKey =
  | 'menu' | 'notRegistered' | 'noOpenRound' | 'chooseChild' | 'consent' | 'declined'
  | 'applied' | 'alreadyApplied' | 'place' | 'noCase' | 'score' | 'addChild' | 'needsVisit' | 'invalid'
  | 'morePrompt' | 'tryAgain'
  | 'smsWindowOpen' | 'smsYourTurn' | 'smsVerified' | 'smsAwarded' | 'smsDisbursed'
  | 'smsSchoolConfirmed' | 'smsRejected';

type Table = Record<MessageKey, string>;

const en: Table = {
  menu: 'Zamu: {round}\n1. Apply\n2. My place\n3. My score\n4. Add a child',
  notRegistered: 'This number is not registered with Zamu. Take the admission number to the school. / Nambari hii haijasajiliwa. Peleka nambari ya usajili shuleni.',
  noOpenRound: 'No bursary round is open now. You will get an SMS when the next one opens.',
  chooseChild: 'Choose a child:\n{list}',
  consent: "Zamu will use {child}'s school record and the last home visit to score need. 1. I agree 2. No",
  declined: 'Nothing was sent. No application was made. You can dial again any time.',
  applied: 'Applied. Case {caseId} for {child}. Place {position} of {total}. You will get an SMS at each step.',
  alreadyApplied: '{child} already applied this round. Case {caseId}, place {position} of {total}.',
  place: '{child}: place {position} of {total}. Need {need} + waiting {bonus} = {priority}.',
  noCase: '{child} has no application in this round. Dial again and choose 1 to apply.',
  score: '{child} need {total}/{max}: fees {fee}, house {house}, livestock {livestock}, land {land}.',
  addChild: "Recorded. Take the child's admission letter to their school. A health volunteer will visit to verify.",
  needsVisit: '{child} needs a home visit before applying. Your request is recorded and a volunteer will come.',
  invalid: 'Wrong choice.',
  morePrompt: '0. More',
  tryAgain: 'Sorry, that did not go through. Please dial again.',
  smsWindowOpen: 'Zamu: {round} bursary is open, {amount} to share. Dial {code} to apply. Your place is public at {site}.',
  smsYourTurn: 'Zamu: {round} is open, {amount} to share, and it is your turn - you waited {rounds} with no award. Dial {code}. Queue: {site}.',
  smsVerified: 'Zamu: {child} is verified for {round}. Case {caseId}, place {position}. Dial {code} for your score.',
  smsAwarded: 'Zamu: {child} is awarded {amount} from {round}. Case {caseId}. The money goes to the school, not to you.',
  smsDisbursed: 'Zamu: {amount} for {child} has been paid to {school}. Case {caseId}. We will confirm with the school.',
  smsSchoolConfirmed: 'Zamu: {school} confirms it received {amount} for {child}. Case {caseId} is complete.',
  smsRejected: 'Zamu: {child} was not selected for {round}. Case {caseId}. You keep your place for the next round.',
};

const sw: Table = {
  menu: 'Zamu: {round}\n1. Omba\n2. Nafasi yangu\n3. Alama zangu\n4. Ongeza mtoto',
  notRegistered: 'This number is not registered with Zamu. Take the admission number to the school. / Nambari hii haijasajiliwa. Peleka nambari ya usajili shuleni.',
  noOpenRound: 'Hakuna raundi ya bursary iliyo wazi sasa. Utapata SMS raundi ijayo ikifunguliwa.',
  chooseChild: 'Chagua mtoto:\n{list}',
  consent: 'Zamu itatumia rekodi ya shule ya {child} na ziara ya mwisho ya nyumbani kupima uhitaji. 1. Nakubali 2. Hapana',
  declined: 'Hakuna kilichotumwa. Hakuna ombi lililowekwa. Unaweza kupiga tena wakati wowote.',
  applied: 'Ombi limepokelewa. Kesi {caseId} ya {child}. Nafasi {position} kati ya {total}. Utapata SMS kila hatua.',
  alreadyApplied: '{child} tayari ameomba raundi hii. Kesi {caseId}, nafasi {position} kati ya {total}.',
  place: '{child}: nafasi {position} kati ya {total}. Uhitaji {need} + kusubiri {bonus} = {priority}.',
  noCase: '{child} hana ombi raundi hii. Piga tena uchague 1 kuomba.',
  score: '{child} uhitaji {total}/{max}: karo {fee}, nyumba {house}, mifugo {livestock}, ardhi {land}.',
  addChild: 'Imepokelewa. Peleka barua ya usajili shuleni. Mhudumu wa afya atatembelea kuthibitisha.',
  needsVisit: '{child} anahitaji ziara ya nyumbani kabla ya kuomba. Ombi lako limepokelewa; mhudumu atakuja.',
  invalid: 'Chaguo si sahihi.',
  morePrompt: '0. Zaidi',
  tryAgain: 'Samahani, haikufanikiwa. Tafadhali piga tena.',
  smsWindowOpen: 'Zamu: bursary ya {round} imefunguliwa, {amount} zitagawanywa. Piga {code} kuomba. Nafasi yako ni wazi: {site}.',
  smsYourTurn: 'Zamu: {round} imefunguliwa, {amount} zitagawanywa, na ni zamu yako - ulisubiri {rounds} bila msaada. Piga {code}. Foleni: {site}.',
  smsVerified: 'Zamu: {child} amethibitishwa kwa {round}. Kesi {caseId}, nafasi {position}. Piga {code} kuona alama.',
  smsAwarded: 'Zamu: {child} amepewa {amount} kutoka {round}. Kesi {caseId}. Pesa huenda shuleni, si kwako.',
  smsDisbursed: 'Zamu: {amount} za {child} zimelipwa {school}. Kesi {caseId}. Tutathibitisha na shule.',
  smsSchoolConfirmed: 'Zamu: {school} imethibitisha ilipokea {amount} za {child}. Kesi {caseId} imekamilika.',
  smsRejected: 'Zamu: {child} hakuchaguliwa {round}. Kesi {caseId}. Unabaki na nafasi yako raundi ijayo.',
};

export const TABLES: Record<Language, Table> = { sw, en };

/** Looks up a message and fills `{name}` placeholders. Unknown placeholders are left in place. */
export function t(language: Language, key: MessageKey, values: Record<string, string | number> = {}): string {
  const template = TABLES[language][key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}
