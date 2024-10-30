/** @type {import('next').NextConfig} */
const nextConfig = {//next.config.js
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      sharp$: false,
      'onnxruntime-node$': false,
    };

    return config;
  },
};

module.exports = nextConfig;