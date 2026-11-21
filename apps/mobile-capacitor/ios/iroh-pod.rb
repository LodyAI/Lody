require 'json'

# Local, generated binding only. No pod or native plugin is linked when the
# outputs are absent; run `pod install` after building/removing the binding.
def lody_iroh_pod
  dist = File.expand_path('../../../packages/iroh-native/mobile-dist/ios', __dir__)
  return unless File.directory?(File.join(dist, 'LodyIroh.xcframework')) &&
                File.file?(File.join(dist, 'swift/lody_iroh_uniffi.swift'))

  spec = {
    'name' => 'LodyIrohBindings',
    'version' => '0.0.1',
    'summary' => 'Local generated Lody iroh mobile binding',
    'homepage' => 'https://github.com/LodyAI/Lody',
    'license' => 'Apache-2.0',
    'authors' => 'LodyAI',
    'source' => { 'git' => 'https://github.com/LodyAI/Lody.git' },
    'platforms' => { 'ios' => '16.4' },
    'swift_versions' => ['5.0'],
    'source_files' => 'swift/*.swift',
    'vendored_frameworks' => 'LodyIroh.xcframework',
    'frameworks' => ['SystemConfiguration'],
    'static_framework' => true
  }
  File.write(File.join(dist, 'LodyIrohBindings.podspec.json'), JSON.pretty_generate(spec))
  pod 'LodyIrohBindings', :path => '../../../../packages/iroh-native/mobile-dist/ios'
end
