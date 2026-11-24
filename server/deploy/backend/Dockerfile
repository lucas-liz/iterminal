# 后端镜像：第一阶段用 Maven 编译，第二阶段只带 JRE 运行
FROM maven:3.9-eclipse-temurin-17 AS build
ARG MAVEN_MIRROR=
WORKDIR /src
RUN if [ -n "$MAVEN_MIRROR" ]; then \
      mkdir -p /root/.m2 && printf '<settings><mirrors><mirror><id>mirror</id><mirrorOf>*</mirrorOf><url>%s</url></mirror></mirrors></settings>' "$MAVEN_MIRROR" > /root/.m2/settings.xml; \
    fi
COPY pom.xml ./
COPY ruoyi-admin ruoyi-admin
COPY ruoyi-common ruoyi-common
COPY ruoyi-framework ruoyi-framework
COPY ruoyi-generator ruoyi-generator
COPY ruoyi-iterminal ruoyi-iterminal
COPY ruoyi-quartz ruoyi-quartz
COPY ruoyi-system ruoyi-system
RUN mvn -q -B -DskipTests package

FROM eclipse-temurin:17-jre
ENV TZ=Asia/Shanghai
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/* \
    && useradd -r -u 10001 -d /app itm && mkdir -p /data/upload /data/logs && chown -R itm /data
WORKDIR /app
COPY --from=build /src/ruoyi-admin/target/ruoyi-admin.jar /app/app.jar
USER itm
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -Duser.timezone=Asia/Shanghai -Djava.security.egd=file:/dev/./urandom -jar /app/app.jar"]
