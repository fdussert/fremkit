# R8 rules for the release build. Debug and verbose logs never reach a release APK.
-assumenosideeffects class android.util.Log {
    public static int d(...);
    public static int v(...);
}
