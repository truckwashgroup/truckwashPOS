import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'nl.truckwash1group.kassa',
  appName: 'Truckwash1 Kassa',
  webDir: 'dist',
  android: { allowMixedContent: true },
  ios: { contentInset: 'always' },
  /*
   * Geen OTA-plugin.
   *
   * Bijwerken gaat via de APK van GitHub Releases -- dezelfde release waar de
   * Windows-installer aan hangt. Dat werkt ook voor wijzigingen aan de native
   * kant, waar een OTA-bundel niet bij komt, en het vraagt geen tweede plek
   * om bestanden te hosten. Zie src/lib/hardware/apkUpdate.ts.
   */
}

export default config
