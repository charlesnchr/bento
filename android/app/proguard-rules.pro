# kotlinx.serialization keeps its generated serializers via the plugin's own rules.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
# OkHttp platform probes
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
# ML Kit (the QR code scanner) creates its component registrars by reflection.
-keep class com.google.mlkit.**.*Registrar { <init>(); }
-keep class * implements com.google.firebase.components.ComponentRegistrar { <init>(); }
# Glance finds a widget's placed ids by its class name (GlanceAppWidgetManager.getGlanceIds,
# updateAll): merged into one class, every Bento widget would be redrawn as whichever updated first.
-keep class * extends androidx.glance.appwidget.GlanceAppWidget
# Glance creates a widget's click callbacks by reflection (getDeclaredConstructor().newInstance()).
# Its own rule keeps these classes but not their constructors, so in release builds a tap on a task's
# circle or a note's checkbox failed with NoSuchMethodException and did nothing.
-keep class * implements androidx.glance.appwidget.action.ActionCallback { <init>(); }
