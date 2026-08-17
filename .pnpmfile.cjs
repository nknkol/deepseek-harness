module.exports = {
  hooks: {
    readPackage(packageManifest) {
      if (
        process.platform === 'openharmony'
        && process.arch === 'arm64'
        && (
          (packageManifest.name === 'lefthook-linux-arm64' && packageManifest.version === '2.1.9')
          || (packageManifest.name === 'lightningcss-linux-arm64-musl' && packageManifest.version === '1.32.0')
          || (packageManifest.name === '@oxlint-tsgolint/linux-arm64' && packageManifest.version === '7.0.2001')
        )
      ) {
        delete packageManifest.os
        delete packageManifest.cpu
        delete packageManifest.libc
      }
      return packageManifest
    },
  },
}
