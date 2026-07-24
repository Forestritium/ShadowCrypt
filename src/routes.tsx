export interface RouteConfig {
  name: string;
  path: string;
  visible?: boolean;
  public?: boolean;
}

export const routes: RouteConfig[] = [
  { name: 'Auth',           path: '/auth',                          public: true  },
  { name: 'Chat',           path: '/chat',                          public: false },
  { name: 'Settings',       path: '/settings',                      public: false },
  { name: 'Linked Devices', path: '/linked-devices',                public: false },
  { name: 'Themes',         path: '/settings/themes',               public: false },
  { name: 'Troubleshooting', path: '/settings/troubleshooting',      public: false },
  { name: 'Privacy Policy', path: '/privacy',                       public: true  },
  { name: 'Safety Number',  path: '/safety-number/:contactId',      public: false },
];
