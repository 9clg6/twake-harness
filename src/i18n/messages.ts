// What the assistants and the creator say to people, in the language of the deployment. The model
// answers in the language of the user; these are the fixed texts around it.

export const LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];

export interface CreatorCommand {
	readonly command: string;
	readonly help: string;
}

export interface Messages {
	// The assistant's first message in its room with the owner
	welcome(name: string): string;
	readonly creator: {
		readonly helpHeader: string;
		readonly commands: readonly CreatorCommand[];
		// Between a command and its help, with the spacing of the language
		readonly commandSeparator: string;
		readonly askName: string;
		created(name: string, userId: string, link: string): string;
		readonly refusals: {
			readonly invalid_name: string;
			readonly exists: string;
			readonly not_on_homeserver: string;
		};
		readonly alreadyHasOne: string;
		mine(name: string, userId: string, link: string): string;
		readonly noneYet: string;
		readonly renameUsage: string;
		renamed(name: string): string;
		readonly renameRefused: string;
		readonly deleted: string;
		readonly nothingToDelete: string;
		readonly recoveryUnavailable: string;
		notUnderstood(text: string): string;
	};
	readonly notices: {
		readonly turnFailed: string;
		readonly busy: string;
		readonly recovered: string;
		readonly noEscrow: string;
	};
	orgGreeting(name: string): string;
}

const ENGLISH: Messages = {
	welcome: (name) =>
		`Hello, I am ${name}, your Twake Space assistant. Tell me what you need; I remember what matters and I ask before I act.`,
	creator: {
		helpHeader: 'I create and manage your Twake Space assistant. Commands:',
		commands: [
			{ command: '/newbot', help: 'create your assistant' },
			{ command: '/mybot', help: 'show your assistant' },
			{ command: '/rename <name>', help: 'rename your assistant' },
			{ command: '/delete', help: 'delete your assistant' },
			{ command: '/recover', help: 'recover the encryption keys of your assistant' },
			{ command: '/help', help: 'this list' }
		],
		commandSeparator: ': ',
		askName: 'Which name do you want for your assistant?',
		created: (name, userId, link) =>
			`Done. Your assistant ${name} is ${userId}. It has opened a private conversation with you: ${link}`,
		refusals: {
			invalid_name: 'That name is not usable: one line, 64 characters at most. Which name?',
			exists: 'You already have an assistant. Send /mybot to see it.',
			not_on_homeserver: 'Your account is not on this homeserver, so I cannot open a room with you.'
		},
		alreadyHasOne: 'You already have an assistant. Send /mybot to see it, or /delete first.',
		mine: (name, userId, link) => `Your assistant ${name} is ${userId}: ${link}`,
		noneYet: 'You have no assistant yet. Send /newbot to create one.',
		renameUsage: 'Send /rename followed by the new name.',
		renamed: (name) => `Your assistant is now called ${name}.`,
		renameRefused: 'Nothing to rename: you have no assistant, or that name is not usable.',
		deleted: 'Your assistant is deleted. Send /newbot when you want a new one.',
		nothingToDelete: 'You have no assistant to delete.',
		recoveryUnavailable: 'Key recovery is not available yet.',
		notUnderstood: (text) => `I did not understand « ${text} ». Send /help for the commands.`
	},
	notices: {
		turnFailed: 'Something went wrong on my side. Please try again in a moment.',
		busy: 'I am busy right now and cannot take this message. Please send it again in a moment.',
		recovered:
			'My identity is back from the escrow. Messages encrypted for my lost device stay unreadable until their keys are restored; everything from now on is fine.',
		noEscrow: 'I found no escrow to recover from; my identity is new from here on.'
	},
	orgGreeting: (name) =>
		`Hello, I am ${name}, the organization agent. Ask me about the organization; I answer its members only.`
};

// Tutoiement, as Hermes spoke. The name is chosen by the user, so no word around it agrees in
// gender with it: "{name} est", never "ton assistant(e) {name}".
const FRENCH: Messages = {
	welcome: (name) =>
		`Bonjour, je m'appelle ${name} et je t'assiste sur Twake Space. Dis-moi ce dont tu as besoin : je retiens ce qui compte et je te demande avant d'agir.`,
	creator: {
		helpHeader: 'Je crée et je gère ton assistant Twake Space :',
		commands: [
			{ command: '/newbot', help: 'créer ton assistant' },
			{ command: '/mybot', help: 'voir ton assistant' },
			{ command: '/rename <nom>', help: 'renommer ton assistant' },
			{ command: '/delete', help: 'supprimer ton assistant' },
			{ command: '/recover', help: 'récupérer les clés de chiffrement de ton assistant' },
			{ command: '/help', help: 'cette liste' }
		],
		commandSeparator: ' : ',
		askName: 'Quel nom veux-tu lui donner ?',
		created: (name, userId, link) =>
			`C'est fait : ${name} est ${userId}. Une conversation privée t'attend : ${link}`,
		refusals: {
			invalid_name:
				'Ce nom ne convient pas : une seule ligne, 64 caractères au plus. Quel nom veux-tu lui donner ?',
			exists: 'Tu as déjà un assistant. Envoie /mybot pour le voir.',
			not_on_homeserver:
				"Ton compte n'est pas sur ce serveur : je ne peux pas ouvrir de conversation avec toi."
		},
		alreadyHasOne: "Tu as déjà un assistant. Envoie /mybot pour le voir, ou /delete d'abord.",
		mine: (name, userId, link) => `${name} est ${userId} : ${link}`,
		noneYet: "Tu n'as pas encore d'assistant. Envoie /newbot pour en créer un.",
		renameUsage: 'Envoie /rename suivi du nouveau nom.',
		renamed: (name) => `C'est noté : le nouveau nom est ${name}.`,
		renameRefused: "Rien à renommer : tu n'as pas d'assistant, ou ce nom ne convient pas.",
		deleted: 'Ton assistant est supprimé. Envoie /newbot quand tu en veux un nouveau.',
		nothingToDelete: "Tu n'as pas d'assistant à supprimer.",
		recoveryUnavailable: "La récupération des clés n'est pas encore disponible.",
		notUnderstood: (text) =>
			`Je n'ai pas compris « ${text} ». Envoie /help pour voir les commandes.`
	},
	notices: {
		turnFailed: "Quelque chose s'est mal passé de mon côté. Réessaie dans un instant.",
		busy: "J'ai trop de demandes en ce moment et je ne peux pas prendre ce message. Renvoie-le dans un instant.",
		recovered:
			'Mon identité est restaurée depuis le séquestre. Les messages chiffrés pour mon ancien appareil restent illisibles tant que leurs clés ne sont pas restaurées ; tout ce qui suit fonctionne normalement.',
		noEscrow:
			"Je n'ai trouvé aucun séquestre d'où restaurer mon identité ; elle est nouvelle à partir de maintenant."
	},
	orgGreeting: (name) =>
		`Bonjour, je m'appelle ${name} et je réponds au nom de l'organisation. Pose-moi tes questions sur elle : je ne réponds qu'à ses membres.`
};

const CATALOG: Readonly<Record<Locale, Messages>> = { en: ENGLISH, fr: FRENCH };

export function getMessages(locale: Locale): Messages {
	return CATALOG[locale];
}
