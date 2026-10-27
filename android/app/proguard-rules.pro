# kotlinx.serialization keeps its generated serializers via the plugin's own rules.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
# OkHttp platform probes
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
