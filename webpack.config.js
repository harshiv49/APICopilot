const path = require("path");

/**@type {import('webpack').Configuration}*/
const config = {
  target: "node", // VS Code extensions run in Node.js context
  mode: "none", // Leave source code as close to original as possible
  entry: "./src/extension.ts", // Entry point
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "extension.js",
    libraryTarget: "commonjs2",
    devtoolModuleFilenameTemplate: "../[resource-path]",
  },
  externals: {
    vscode: "commonjs vscode", // VS Code module must be excluded
    // Externalize LanceDB native modules - they can't be bundled
    "@lancedb/lancedb": "commonjs @lancedb/lancedb",
  },
  resolve: {
    extensions: [".ts", ".js"],
    // Remove fallback section for Node.js environment
    mainFields: ["main", "module"],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: "ts-loader",
          },
        ],
      },
      {
        test: /\.node$/,
        loader: "node-loader",
      },
    ],
  },
  devtool: "nosources-source-map",
  infrastructureLogging: {
    level: "log",
  },
};

module.exports = config;
