declare global {
  namespace NodeJS {
    interface ProcessEnv {
      COINDAR_ACCESSTOKEN: string;
      COINDAR_BASE_URL_API: string;
      BITLY_ACCESS_TOKEN: string;
      BITLY_BASE_URL: string;
    }
  }
}

export {}
