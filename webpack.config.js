const path = require('path')
const TerserPlugin = require('terser-webpack-plugin')
require('dotenv').config()

const ASSET_PATH = process.env.ASSET_PATH || '/dicom-reader/'

module.exports = {
    mode: 'production',
    entry: {
        'dicom-reader': { import: path.join(__dirname, 'src', 'index.ts') },
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: 'ts-loader',
                exclude: '/node_modules/',
            },
        ],
    },
    optimization: {
        minimize: true,
        minimizer: [
            new TerserPlugin(),
        ],
        splitChunks: false,
    },
    output: {
        path: path.resolve(__dirname, 'umd'),
        publicPath: ASSET_PATH,
        library: 'EpiCDicomReader',
        libraryTarget: 'umd',
    },
    resolve: {
        extensions: ['.ts', '.js', '.json'],
        alias: {
            '#root': path.resolve(__dirname, './'),
            '#dicom': path.resolve(__dirname, 'src', 'dicom'),
            '#types': path.resolve(__dirname, 'src', 'types'),
            '#util': path.resolve(__dirname, 'src', 'util'),
        },
        symlinks: false
    },
}
