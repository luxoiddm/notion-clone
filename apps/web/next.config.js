/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      // Публичная ссылка на файл: короткий адрес /f/{token} проксируется на
      // сервер и не раскрывает ни владельца, ни путь к файлу на диске.
      {
        source: '/f/:token',
        destination: `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/public-files/:token`,
      },
      {
        source: '/api/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
