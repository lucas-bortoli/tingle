export const ptBr = {
  tools: {
    search: {
      description: "Pesquisa na internet",
    },
  },
};

export const enUs: I18nObject = {
  tools: {
    search: {
      description: "Searches the web",
    },
  },
};

export const L = (h: (l: I18nObject) => string) => h(ptBr);

type I18nObject = typeof ptBr;
