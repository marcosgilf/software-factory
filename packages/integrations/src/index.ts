declare const integrationIdBrand: unique symbol;

export type IntegrationId = string & { readonly [integrationIdBrand]: true };

export type IntegrationProvider = 'github';
