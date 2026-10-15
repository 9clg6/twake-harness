// An exchange between an owner (A) and someone else (B), as their assistant may read it in a
// conversation it is not spoken to in, and what it could then propose to its owner. Written for
// this suite, in the two languages the assistants speak: no exchange of real people is among them.
export type ConversationCase = readonly [lines: readonly string[], proposes: readonly string[]];

// A time is agreed: a meeting to put in the calendar
const MEETINGS: readonly ConversationCase[] = [
	[
		["A: Il faut qu'on parle du budget.", 'B: On voit ça lundi à 8h ?', 'A: Ok, lundi 8h.'],
		['create_event']
	],
	[['B: Point rapide demain 10h ?', 'A: Ça marche.'], ['create_event']],
	[["A: Let's sync on the roadmap Thursday at 3pm.", 'B: Works for me.'], ['create_event']],
	[['B: Lunch on Friday at noon?', 'A: Yes, perfect.'], ['create_event']],
	[['A: On se fait une rétro mardi 14h ?', 'B: Yes, je réserve la salle.'], ['create_event']],
	[
		['B: Can we do the demo on the 20th at 11?', 'A: Sure, the 20th at 11 it is.'],
		['create_event']
	],
	[
		['A: Je passe te voir mercredi à 16h pour la maquette.', 'B: Top, à mercredi.'],
		['create_event']
	],
	[['B: Kickoff next Monday 9:30, ok for you?', 'A: Ok for me.'], ['create_event']],
	[['A: Appelle-moi demain à 9h pour le contrat.', 'B: Noté, demain 9h.'], ['create_event']],
	[['B: On décale notre point à jeudi 11h ?', "A: Oui jeudi 11h c'est mieux."], ['create_event']],
	[['A: On voit ça lundi à 8h.', 'B: Parfait.'], ['create_event']],
	[['B: See you Tuesday at 10 for the review then.', 'A: See you then.'], ['create_event']]
];

// The owner is asked when they are free: their calendar to look at
const AVAILABILITY: readonly ConversationCase[] = [
	[['B: Tu es dispo jeudi à 15h ?'], ['read_freebusy']],
	[['B: Are you free tomorrow morning for a call?'], ['read_freebusy']],
	[["B: Tu aurais un créneau cette semaine pour qu'on avance ?"], ['read_freebusy']],
	[['B: Could you do Wednesday at 2pm?', 'A: Let me check.'], ['read_freebusy']],
	[
		['B: Dispo vendredi après-midi pour un atelier ?', 'A: Je regarde mon agenda.'],
		['read_freebusy']
	],
	[['B: When are you available next week?'], ['read_freebusy']],
	[["B: Tu peux lundi matin ou c'est déjà pris ?"], ['read_freebusy']]
];

// The owner says they will send something by mail, or is asked to
const MAILS: readonly ConversationCase[] = [
	[["B: Tu peux m'envoyer le compte rendu par mail ?", "A: Oui je te l'envoie."], ['send_email']],
	[["A: Je t'envoie la facture par mail ce soir.", 'B: Merci !'], ['send_email']],
	[['B: Can you email me the slides?', 'A: Will do.'], ['send_email']],
	[["A: I'll send you the contract by email right after this.", 'B: Great.'], ['send_email']],
	[['B: Envoie-moi ton RIB par mail stp.', 'A: Ok.'], ['send_email']],
	[["A: I'll mail the team the summary.", 'B: Thanks.'], ['send_email']],
	[
		['B: Tu peux écrire au client pour confirmer la livraison ?', 'A: Oui, je lui envoie un mail.'],
		['send_email']
	]
];

// An invitation was sent to the owner, who says they come
const INVITATIONS: readonly ConversationCase[] = [
	[
		["B: Je t'ai envoyé l'invitation pour la revue de vendredi.", "A: Ok je l'accepte."],
		['accept_invitation']
	],
	[['B: Did you see my invite for the workshop?', 'A: Yes, count me in.'], ['accept_invitation']],
	[
		["B: Tu viens à la réunion de jeudi ? Je t'ai invité.", 'A: Oui je serai là.'],
		['accept_invitation']
	],
	[['B: I sent you a calendar invite for Monday.', 'A: Accepting it now.'], ['accept_invitation']]
];

// A mail the owner has to find
const LOOKUPS: readonly ConversationCase[] = [
	[
		['B: Tu as reçu mon mail sur le budget ?', 'A: Je ne le vois pas, je cherche.'],
		['search_emails']
	],
	[['B: Did you get the email from the bank?', 'A: Not sure, let me look.'], ['search_emails']],
	[
		["B: Je t'ai transféré le mail du client hier.", "A: Ah, je ne l'ai pas vu."],
		['search_emails']
	],
	[["B: It's all in the email I sent last week.", "A: I'll dig it up."], ['search_emails']]
];

// Nothing to propose: small talk, what is over, what is vague, what is someone else's, what the
// owner already did
const NOTHING: readonly ConversationCase[] = [
	[['A: Salut ça va ?', 'B: Oui et toi ?'], []],
	[['B: Bon week-end !', 'A: Merci toi aussi.'], []],
	[["A: La réunion d'hier était longue…", 'B: Tellement.'], []],
	[["A: Faut qu'on se voie un de ces jours.", 'B: Carrément.'], []],
	[['B: We should grab coffee sometime.', 'A: Definitely.'], []],
	[['A: Finalement on annule le point de demain.', 'B: Ok pas de souci.'], []],
	[["A: J'ai eu Paul au téléphone, tout est bon.", 'B: Super.'], []],
	[['B: Did you watch the game last night?', 'A: Yes, crazy.'], []],
	[['A: Le client a adoré la démo.', 'B: Génial !'], []],
	[['B: Marie a une réunion avec la direction lundi.', 'A: Ah, bon courage à elle.'], []],
	[['A: I already put it in my calendar.', 'B: Perfect.'], []],
	[["A: C'est bon, j'ai déjà envoyé le mail ce matin.", 'B: Top merci.'], []],
	[["B: T'as vu le nouveau bureau ?", 'A: Pas encore.'], []],
	[['A: I hate Monday meetings.', 'B: Same.'], []],
	[['B: Le train a encore du retard.', 'A: Courage.'], []],
	[['B: Thanks for your help today.', 'A: Anytime.'], []],
	[['B: Tu as pensé quoi de la présentation ?', 'A: Très claire.'], []],
	[['A: On en reparle.', 'B: Ok.'], []],
	[['B: Happy birthday!', 'A: Thank you!'], []],
	[['A: Le mail du client était vraiment sec.', "B: Oui j'ai vu."], []],
	[['A: I was free yesterday but nobody called.', 'B: Sorry about that.'], []],
	[['B: The invite from last month was a mess.', 'A: True.'], []],
	[['A: On a bien fait de décaler la semaine dernière.', 'B: Oui.'], []],
	[["B: J'ai déjà accepté l'invitation de mon côté.", 'A: Parfait.'], []]
];

export const CONVERSATION_CASES: readonly ConversationCase[] = [
	...MEETINGS,
	...AVAILABILITY,
	...MAILS,
	...INVITATIONS,
	...LOOKUPS,
	...NOTHING
];
